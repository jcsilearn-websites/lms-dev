import { MAX_HEARTBEAT_RANGES } from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { csvLine } from '../../core/csv';
import { ForbiddenError } from '../../core/errors';
import type { Database } from '../../db/client';
import { type AccessSpec, assertAccess, OfferingNotFoundError } from '../courses';
import {
  LearnerNotFoundError,
  NotAVideoItemError,
  ProgressItemNotFoundError,
  VideoChangedError,
  WrongCompletionRuleError,
} from './progress.errors';
import type { ClassQuery, ClassSort, ProgressRepository, Row } from './progress.repository';

export type { ClassQuery } from './progress.repository';

const MAX_VIDEO_SECONDS = 86_400;

/**
 * The ranges a client claims, as a multirange literal the database can trust: whole seconds only, rounded INWARD (a
 * second counts when it was played completely), inside [0, 24 h), at most 16 ranges. Anything else is dropped.
 */
export function rangesLiteral(ranges: readonly (readonly [number, number])[]): string {
  const out: string[] = [];
  for (const [from, to] of ranges.slice(0, MAX_HEARTBEAT_RANGES)) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const lo = Math.ceil(Math.max(0, from));
    const hi = Math.floor(Math.min(MAX_VIDEO_SECONDS, to));
    if (hi > lo) out.push(`[${lo},${hi})`);
  }
  return `{${out.join(',')}}`;
}

export interface ProgressConfig {
  /** rows per page of the class table (and per query of the CSV export) */
  csvPage: number;
}

export function createProgressService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  progressRepo: ProgressRepository;
  config?: ProgressConfig;
}) {
  const { db, progressRepo } = deps;
  const csvPage = deps.config?.csvPage ?? 100;

  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      offeringId,
      viewAll: can(ctx, 'course.read'),
      accountAllowed: can(ctx, permission),
      allowedBy: participationsGranting(permission),
    };
  };
  const tenantOf = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };

  /** Maps the verdict of the database gate to the answers every offering route gives. */
  function verdict(v: unknown): void {
    switch (v) {
      case 'ok':
      case 'duplicate':
        return;
      case 'no_offering':
        throw new OfferingNotFoundError(); // takes no part: the offering does not exist for them
      case 'forbidden':
        throw new ForbiddenError(); // an instructor / assistant previewing: no learner progress
      case 'not_visible':
        throw new ProgressItemNotFoundError();
      case 'not_video':
        throw new NotAVideoItemError();
      case 'video_changed':
        throw new VideoChangedError();
      case 'wrong_rule':
        throw new WrongCompletionRuleError();
      default:
        throw new ProgressItemNotFoundError();
    }
  }

  const pct = (watched: unknown, total: unknown): number | null =>
    Number(total) > 0 ? Math.round((Number(watched) * 100) / Number(total)) : null;

  return {
    // ---------------------------------------------------------------- writes (2 round trips with the session lookup)
    /**
     * One heartbeat of a player: the ranges played since the last one. ONE call of a SECURITY DEFINER function on an
     * autocommit connection (the visibility rule, the integrity checks and the merge are in the database).
     */
    async heartbeat(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      body: {
        videoId: string;
        streamId: string;
        seq: number;
        ranges: readonly (readonly [number, number])[];
        position: number;
        rate: number;
      },
    ) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        progressRepo.heartbeat(conn, {
          tenantId,
          userId: ctx.userId,
          offeringId,
          itemId,
          videoId: body.videoId,
          streamId: body.streamId,
          seq: body.seq,
          ranges: rangesLiteral(body.ranges),
          position: Math.round(Math.min(Math.max(body.position, 0), MAX_VIDEO_SECONDS)),
          rate: body.rate,
        }),
      );
      verdict(r.result);
      return {
        result: r.result as 'ok' | 'duplicate',
        watchedSeconds: Number(r.watched_seconds),
        durationSeconds: Number(r.duration_s),
        percent: Number(r.percent),
        completed: r.completed === true,
        positionSeconds: Number(r.position_s),
      };
    },

    /** 'viewed' (opened / downloaded), 'complete' and 'uncomplete' (manual items). */
    async mark(
      ctx: RequestContext,
      offeringId: string,
      itemId: string,
      action: 'viewed' | 'complete' | 'uncomplete',
    ) {
      const tenantId = tenantOf(ctx);
      const r = await db.withoutTenant((conn) =>
        progressRepo.mark(conn, { tenantId, userId: ctx.userId, offeringId, itemId, action }),
      );
      verdict(r.result);
      return { status: r.status as 'not_started' | 'in_progress' | 'completed' };
    },

    // ---------------------------------------------------------------- reads (4 round trips)
    /** The caller's own progress in one offering. Someone who is not a learner of it gets `participant: false`. */
    async mine(ctx: RequestContext, offeringId: string) {
      const a = spec(ctx, offeringId, 'content.view');
      const r = await db.withTenant(a.tenantId, (tx) => progressRepo.mine(tx, a));
      assertAccess(r.acc);
      const d = r.data ?? {};
      const total = Number(d.totalRequired ?? 0);
      const done = Number(d.completedRequired ?? 0);
      return {
        participant: d.participant === true,
        completedRequired: done,
        totalRequired: total,
        percent: pct(done, total),
        modules: (d.modules as Row[] | undefined) ?? [],
        items: (d.items as Row[] | undefined) ?? [],
        resume: (d.resume as Row | null | undefined) ?? null,
      };
    },

    /** "My courses": percentages of every course the caller learns in, and where to continue. */
    async mineEverywhere(ctx: RequestContext) {
      const tenantId = tenantOf(ctx);
      const r = await db.withTenant(tenantId, (tx) =>
        progressRepo.mineEverywhere(tx, tenantId, ctx.userId),
      );
      return {
        offerings: (r.offerings as Row[] | undefined) ?? [],
        resume: (r.resume as Row | null | undefined) ?? null,
      };
    },

    /** The class table (instructors, assistants and administrators; learners never see other learners). */
    async classPage(ctx: RequestContext, offeringId: string, q: ClassQuery) {
      const a = spec(ctx, offeringId, 'progress.view_class');
      const r = await db.withTenant(a.tenantId, (tx) => progressRepo.classPage(tx, a, q));
      assertAccess(r.acc);
      const more = r.rows.length > q.limit;
      const rows = more ? r.rows.slice(0, q.limit) : r.rows;
      const last = rows.at(-1);
      return {
        modules: r.modules,
        items: rows.map(({ sortKey: _k, ...row }) => row),
        total: r.total,
        nextCursor:
          more && last
            ? encodeCursor({
                key: (last.sortKey as string | number) ?? '',
                id: last.participantId as string,
              })
            : null,
      };
    },

    async learner(ctx: RequestContext, offeringId: string, participantId: string) {
      const a = spec(ctx, offeringId, 'progress.view_class');
      const r = await db.withTenant(a.tenantId, (tx) =>
        progressRepo.drilldown(tx, a, participantId),
      );
      assertAccess(r.acc);
      if (!r.learner) throw new LearnerNotFoundError();
      const total = Number(r.learner.totalRequired);
      const done = Number(r.learner.completedRequired);
      return { learner: { ...r.learner, percent: pct(done, total) }, items: r.items };
    },

    /**
     * The class table as CSV, one query per page (so memory stays flat however large the class is). Cells go through
     * the same safe writer as the import's error report (a leading = + - @ tab CR is neutralised).
     */
    async *classCsv(
      ctx: RequestContext,
      offeringId: string,
      filters: Pick<ClassQuery, 'section' | 'status' | 'removed' | 'sort' | 'dir'>,
    ): AsyncGenerator<string> {
      const a = spec(ctx, offeringId, 'progress.view_class');
      let after: ClassQuery['after'] = null;
      let header = false;
      for (;;) {
        const page = await db.withTenant(a.tenantId, (tx) =>
          progressRepo.classPage(tx, a, { ...filters, limit: csvPage, after }),
        );
        assertAccess(page.acc);
        if (!header) {
          header = true;
          yield `﻿${csvLine([
            'Learner',
            'Email',
            'Section',
            'Status',
            'Completed required items',
            'Required items',
            'Progress %',
            'Last activity',
            ...page.modules.map((m) => `${m.title} %`),
          ])}`;
        }
        const more = page.rows.length > csvPage;
        const rows = more ? page.rows.slice(0, csvPage) : page.rows;
        for (const r of rows) {
          const mods = (r.modules as { percent: number | null }[]) ?? [];
          yield csvLine([
            r.displayName as string,
            r.email as string,
            (r.sectionName as string | null) ?? '',
            r.status as string,
            r.completedRequired as number,
            r.totalRequired as number,
            (r.percent as number | null) ?? '',
            r.lastActivityAt ? new Date(r.lastActivityAt as string).toISOString() : '',
            ...mods.map((m) => m.percent ?? ''),
          ]);
        }
        const last = rows.at(-1);
        if (!more || !last) return;
        after = { key: (last.sortKey as string | number) ?? '', id: last.participantId as string };
      }
    },
  };
}
export type ProgressService = ReturnType<typeof createProgressService>;
export type { ClassSort };

// ---------------------------------------------------------------- the keyset cursor (opaque to the client)
export function encodeCursor(c: { key: string | number; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCursor(raw: string | undefined): { key: string | number; id: string } | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      key?: unknown;
      id?: unknown;
    };
    const id = typeof c.id === 'string' && /^[0-9a-f-]{36}$/i.test(c.id) ? c.id : null;
    if (id && (typeof c.key === 'string' || typeof c.key === 'number')) return { key: c.key, id };
  } catch {
    // fall through
  }
  return null;
}

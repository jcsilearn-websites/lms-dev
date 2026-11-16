import type { Readable } from 'node:stream';
import type { UsageResponse, UsageRow } from '../../contracts';
import type { RequestContext } from '../../core/context';
import { csvLine } from '../../core/csv';
import { type XlsxCell, xlsxStream } from '../../core/xlsx';
import type { Database } from '../../db/client';
import type { UsageRepository } from './usage.repository';

/**
 * The assumed share of viewing per rendition (USAGE_RENDITION_MIX). Anything that is not a non-negative number is dropped; when
 * nothing usable is left the default is used. The mix is stored in every monthly snapshot.
 */
export function parseRenditionMix(raw: string): Record<string, number> {
  const fallback = { '360p': 0.2, '480p': 0.3, '720p': 0.5 };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    return Object.values(out).some((v) => v > 0) ? out : fallback;
  } catch {
    return fallback;
  }
}

export const USAGE_NOTE =
  'Video GB is an estimate: watched unique seconds x the measured bytes per second of each video, weighted by the assumed ' +
  'rendition mix (players pick renditions themselves). Hours count unique seconds played, so re-watching adds nothing. ' +
  'Storage is measured when the month closes. A month closes two hours after it ends in the college time zone.';

const GB = 1_000_000_000;
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** The first day of the month containing `now`, UTC (the platform has no zone; each college buckets in its own). */
export function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function createUsageService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  usageRepo: UsageRepository;
  config: { renditionMix: Record<string, number> };
  now?: () => Date;
}) {
  const { db, usageRepo, config } = deps;
  const clock = deps.now ?? (() => new Date());

  async function load(ctx: RequestContext, month?: string): Promise<UsageResponse> {
    const m = month ?? currentMonth(clock());
    const rows = await db.withoutTenant((c) =>
      usageRepo.platformUsage(c, ctx.userId, m, config.renditionMix),
    );
    const mapped: UsageRow[] = rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      provisional: r.provisional,
      revision: Number(r.revision),
      timeZone: r.time_zone,
      billableLearners: Number(r.billable_learners),
      activeUsers: Number(r.active_users),
      videoHours: round(Number(r.video_seconds) / 3600, 2),
      videoGbEstimate: round(Number(r.video_gb_estimate), 3),
      storageGb: round(Number(r.storage_bytes) / GB, 3),
      offerings: Number(r.offerings),
      activeOfferings: Number(r.active_offerings),
      members: Number(r.members),
    }));
    return { month: m, rows: mapped, renditionMix: config.renditionMix, note: USAGE_NOTE };
  }

  const HEADER = [
    'College',
    'Slug',
    'Month',
    'State',
    'Billable learners',
    'Active users',
    'Video hours watched',
    'Video GB (estimate)',
    'Storage GB',
    'Offerings',
    'Offerings with activity',
    'Active members',
  ];
  const line = (month: string, r: UsageRow): XlsxCell[] => [
    r.name,
    r.slug,
    month.slice(0, 7),
    r.provisional ? 'open (provisional)' : `closed (revision ${r.revision})`,
    r.billableLearners,
    r.activeUsers,
    r.videoHours,
    r.videoGbEstimate,
    r.storageGb,
    r.offerings,
    r.activeOfferings,
    r.members,
  ];

  return {
    list: load,
    async csv(ctx: RequestContext, month?: string): Promise<string> {
      const u = await load(ctx, month);
      return `﻿${csvLine(HEADER)}${u.rows.map((r) => csvLine(line(u.month, r))).join('')}`;
    },
    async xlsx(ctx: RequestContext, month?: string): Promise<Readable> {
      const u = await load(ctx, month);
      return xlsxStream('Usage', [HEADER, ...u.rows.map((r) => line(u.month, r))]);
    },
    /** The scheduled job: freezes every month that ended. Safe to run any number of times. */
    async closeDueMonths(): Promise<number> {
      return db.withoutTenant((c) => usageRepo.closeDue(c, clock(), config.renditionMix));
    },
  };
}
export type UsageService = ReturnType<typeof createUsageService>;

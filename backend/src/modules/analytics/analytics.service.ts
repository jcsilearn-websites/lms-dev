import type { Readable } from 'node:stream';
import type {
  AnalyticsSettings,
  AtRiskSettings,
  ReportTable,
  ReportTableId,
  UpdateAnalyticsSettingsRequest,
} from '../../contracts';
import { can, type Permission, participationsGranting } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { csvLine } from '../../core/csv';
import { ForbiddenError } from '../../core/errors';
import type { BackgroundTasks } from '../../core/mailer';
import { type XlsxCell, xlsxStream } from '../../core/xlsx';
import type { Database } from '../../db/client';
import { type AccessSpec, assertAccess } from '../courses';
import { describeRules, formatDay } from './analytics.atrisk';
import {
  InvalidTimeZoneError,
  ReportDisabledError,
  VideoItemNotFoundError,
} from './analytics.errors';
import type { AnalyticsRepository, Row } from './analytics.repository';
import { REPORT_ROW_LIMIT } from './analytics.repository';

type Col = ReportTable['columns'][number];

/** Column definitions of every report table (JSON and exports share them). Keys are the SQL column names. */
const COLUMNS: Record<ReportTableId, { title: string; kind: Col[] }> = {
  activity: {
    title: 'Daily activity',
    kind: [
      { key: 'day', label: 'Day', kind: 'date' },
      { key: 'active_users', label: 'Active users', kind: 'number' },
      { key: 'active_learners', label: 'Active learners', kind: 'number' },
      { key: 'video_minutes', label: 'Video minutes watched', kind: 'number' },
    ],
  },
  organisation: {
    title: 'Completion and average scores',
    kind: [
      { key: 'name', label: 'Group', kind: 'text' },
      { key: 'learners', label: 'Learners', kind: 'number' },
      { key: 'enrolments', label: 'Enrolments', kind: 'number' },
      { key: 'avg_completion', label: 'Average completion', kind: 'percent' },
      { key: 'avg_score', label: 'Average released score', kind: 'percent' },
      { key: 'flagged_learners', label: 'Learners flagged', kind: 'number' },
    ],
  },
  'course-health': {
    title: 'Needs attention',
    kind: [
      { key: 'course_code', label: 'Code', kind: 'text' },
      { key: 'course', label: 'Course', kind: 'text' },
      { key: 'term', label: 'Term', kind: 'text' },
      { key: 'learners', label: 'Learners', kind: 'number' },
      { key: 'weeks_since_content', label: 'Weeks since content changed', kind: 'number' },
      {
        key: 'oldest_waiting_days',
        label: 'Oldest work waiting to be graded (days)',
        kind: 'number',
      },
      { key: 'attention', label: 'Why it needs attention', kind: 'text' },
    ],
  },
  gradebooks: {
    title: 'Gradebook approval status',
    kind: [
      { key: 'course_code', label: 'Code', kind: 'text' },
      { key: 'course', label: 'Course', kind: 'text' },
      { key: 'term', label: 'Term', kind: 'text' },
      { key: 'status', label: 'Gradebook', kind: 'text' },
      { key: 'version', label: 'Version', kind: 'number' },
      { key: 'submitted_at', label: 'Submitted', kind: 'datetime' },
      { key: 'learners', label: 'Learners', kind: 'number' },
    ],
  },
  'grading-backlog': {
    title: 'Grading backlog',
    kind: [
      { key: 'course_code', label: 'Code', kind: 'text' },
      { key: 'course', label: 'Course', kind: 'text' },
      { key: 'submissions', label: 'Hand-ins waiting', kind: 'number' },
      { key: 'attempts', label: 'Quiz attempts waiting', kind: 'number' },
      { key: 'oldest_waiting', label: 'Oldest waiting since', kind: 'datetime' },
    ],
  },
  'at-risk': {
    title: 'Learners flagged by department',
    kind: [
      { key: 'department', label: 'Department', kind: 'text' },
      { key: 'flagged_learners', label: 'Flagged learners', kind: 'number' },
      { key: 'behind', label: 'Behind', kind: 'number' },
      { key: 'missed_deadlines', label: 'Missed deadlines', kind: 'number' },
      { key: 'low_score', label: 'Low average score', kind: 'number' },
      { key: 'inactive', label: 'Inactive', kind: 'number' },
      { key: 'learners', label: 'Learners with enrolments', kind: 'number' },
    ],
  },
  resources: {
    title: 'Storage and video',
    kind: [
      { key: 'metric', label: 'Measure', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'number' },
      { key: 'unit', label: 'Unit', kind: 'text' },
    ],
  },
};

const DEFAULT_AT_RISK: AtRiskSettings = {
  behindEnabled: true,
  missedDeadlinesEnabled: true,
  missedDeadlines: 2,
  lowScoreEnabled: true,
  passMarkPercent: 40,
  inactiveEnabled: true,
  inactiveDays: 14,
};

function cell(v: unknown, kind: Col['kind']): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (kind === 'number' || kind === 'percent' || kind === 'bytes') return Number(v);
  return String(v);
}

export function summaryOf(id: ReportTableId, rows: Row[]): string {
  const n = rows.length;
  switch (id) {
    case 'activity': {
      const last = rows.at(-1);
      return `Active users on each of the last ${n} days${last ? `; the latest day had ${last.active_users} active users` : ''}.`;
    }
    case 'organisation':
      return `${n} groups with their learners, average completion and average released score.`;
    case 'course-health':
      return n === 0
        ? 'No running course needs attention: content is recent and grading is keeping up.'
        : `${n} running ${n === 1 ? 'course needs' : 'courses need'} attention. This is about the upkeep of a course (content, waiting work), not about any person.`;
    case 'gradebooks':
      return `${n} ${n === 1 ? 'offering' : 'offerings'} and the state of ${n === 1 ? 'its gradebook' : 'their gradebooks'}.`;
    case 'grading-backlog':
      return n === 0
        ? 'Nothing is waiting to be graded.'
        : `${n} ${n === 1 ? 'offering has' : 'offerings have'} work waiting to be graded.`;
    case 'at-risk':
      return `Learners flagged by the at-risk rules, counted per department (no names).`;
    case 'resources':
      return 'Storage in use and video watched.';
  }
}

export interface AnalyticsServiceConfig {
  /** rows fetched per page for exports of the at-risk list */
  csvPage: number;
  /** the activity cache is bounded: when full the oldest entries go (the cost of a miss is one idempotent upsert) */
  activityCacheMax: number;
  /** rollup batch size (learners per refresh statement) */
  rollupBatch: number;
}

export function createAnalyticsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  analyticsRepo: AnalyticsRepository;
  background: BackgroundTasks;
  config: AnalyticsServiceConfig;
  now?: () => Date;
}) {
  const { db, analyticsRepo: repo, background, config } = deps;
  const clock = deps.now ?? (() => new Date());

  const tenantOf = (ctx: RequestContext): string => {
    if (!ctx.tenantId) throw new ForbiddenError();
    return ctx.tenantId;
  };
  const spec = (ctx: RequestContext, offeringId: string, permission: Permission): AccessSpec => ({
    tenantId: tenantOf(ctx),
    userId: ctx.userId,
    offeringId,
    viewAll: can(ctx, 'course.read'),
    accountAllowed: can(ctx, permission),
    allowedBy: participationsGranting(permission),
  });

  // ------------------------------------------------------------ activity: at most one write per user and local day
  // session -> the instant until which today is already recorded. A miss costs one idempotent upsert, run after the response.
  const recorded = new Map<string, number>();

  async function loadSettings(tenantId: string): Promise<AnalyticsSettings> {
    const s = await db.withTenant(tenantId, (tx) => repo.getSettings(tx, tenantId));
    return toSettings(s);
  }
  function toSettings(
    s: Awaited<ReturnType<AnalyticsRepository['getSettings']>>,
  ): AnalyticsSettings {
    const a = s.analytics ?? {};
    const u = s.usage ?? {};
    return {
      timeZone: s.tz,
      atRisk: { ...DEFAULT_AT_RISK, ...(s.atRisk as Partial<AtRiskSettings>) },
      showCourseHealth: a.showCourseHealth === undefined ? true : a.showCourseHealth === true,
      courseHealthWeeks: Number(a.courseHealthWeeks ?? 3),
      courseHealthBacklogDays: Number(a.courseHealthBacklogDays ?? 14),
      usageMinActiveDays: Number(u.minActiveDays ?? 1),
      usageLearnersOnly: u.learnersOnly === undefined ? true : u.learnersOnly === true,
    };
  }

  async function* atRiskRows(ctx: RequestContext, offeringId: string, pageSize: number) {
    const a = spec(ctx, offeringId, 'atrisk.view');
    let after: string | null = null;
    for (;;) {
      const page = await db.withTenant(a.tenantId, (tx) =>
        repo.atRiskPage(tx, a, { limit: pageSize, after }),
      );
      assertAccess(page.acc);
      const more = page.rows.length > pageSize;
      const rows = more ? page.rows.slice(0, pageSize) : page.rows;
      yield { page, rows };
      const last = rows.at(-1);
      if (!more || !last) return;
      after = last.participantId as string;
    }
  }

  function mapAtRisk(page: { settings: Row; tz: string }, rows: Row[]) {
    const settings = { ...DEFAULT_AT_RISK, ...(page.settings as Partial<AtRiskSettings>) };
    return rows.map((r) => ({
      participantId: r.participantId as string,
      displayName: r.displayName as string,
      email: r.email as string,
      rules: describeRules(r, settings, page.tz, clock()),
    }));
  }

  async function reportTable(
    ctx: RequestContext,
    id: ReportTableId,
    q: { scope?: string | undefined; days?: number | undefined },
  ): Promise<ReportTable> {
    const tenantId = tenantOf(ctx);
    const def = COLUMNS[id];
    // ONE statement: the rows, the time zone, the course-health window and the data-as-of time together
    const out = await db.withTenant(tenantId, (tx) =>
      repo.reportRows(tx, tenantId, id, { scope: q.scope ?? 'department', days: q.days ?? 30 }),
    );
    if (out.disabled) throw new ReportDisabledError();
    const truncated = out.rows.length > REPORT_ROW_LIMIT;
    const rows = (truncated ? out.rows.slice(0, REPORT_ROW_LIMIT) : out.rows).map((r) =>
      Object.fromEntries(def.kind.map((c) => [c.key, cell(r[c.key], c.kind)])),
    );
    const title = id === 'organisation' ? `${def.title} by ${q.scope ?? 'department'}` : def.title;
    return {
      id,
      title,
      summary: summaryOf(id, out.rows),
      asOf: out.asOf,
      timeZone: out.tz,
      columns: def.kind,
      rows,
      truncated,
    };
  }

  return {
    // ---------------------------------------------------------------- activity
    /** Called after a response (never inside the request): remembers the day per session, writes at most once a day. */
    noteActivity(auth: { sessionId: string; userId: string; tenantId: string | null }): void {
      if (!auth.tenantId) return;
      const until = recorded.get(auth.sessionId);
      const now = clock().getTime();
      if (until !== undefined && now < until) return;
      // mark as in flight for a minute so a burst of requests writes once, whatever the outcome
      recorded.set(auth.sessionId, now + 60_000);
      if (recorded.size > config.activityCacheMax) {
        const first = recorded.keys().next();
        if (!first.done) recorded.delete(first.value);
      }
      const tenantId = auth.tenantId;
      background.run(async () => {
        try {
          const next = await db.withoutTenant((conn) =>
            repo.activityTouch(conn, tenantId, auth.userId),
          );
          recorded.set(auth.sessionId, next.getTime());
        } catch (err) {
          recorded.delete(auth.sessionId);
          throw err;
        }
      });
    },
    /** tests: forget what was recorded */
    resetActivityCache(): void {
      recorded.clear();
    },

    // ---------------------------------------------------------------- settings
    async getSettings(ctx: RequestContext): Promise<AnalyticsSettings> {
      return loadSettings(tenantOf(ctx));
    },
    async updateSettings(ctx: RequestContext, body: UpdateAnalyticsSettingsRequest) {
      const tenantId = tenantOf(ctx);
      const ok = await db.withTenant(tenantId, async (tx) => {
        const before = toSettings(await repo.getSettings(tx, tenantId));
        const after: AnalyticsSettings = {
          timeZone: body.timeZone ?? before.timeZone,
          atRisk: { ...before.atRisk, ...(body.atRisk ?? {}) },
          showCourseHealth: body.showCourseHealth ?? before.showCourseHealth,
          courseHealthWeeks: body.courseHealthWeeks ?? before.courseHealthWeeks,
          courseHealthBacklogDays: body.courseHealthBacklogDays ?? before.courseHealthBacklogDays,
          usageMinActiveDays: body.usageMinActiveDays ?? before.usageMinActiveDays,
          usageLearnersOnly: body.usageLearnersOnly ?? before.usageLearnersOnly,
        };
        const written = await repo.setSettings(tx, {
          tenantId,
          userId: ctx.userId,
          timeZone: after.timeZone,
          atRisk: after.atRisk,
          analytics: {
            showCourseHealth: after.showCourseHealth,
            courseHealthWeeks: after.courseHealthWeeks,
            courseHealthBacklogDays: after.courseHealthBacklogDays,
          },
          usage: { minActiveDays: after.usageMinActiveDays, learnersOnly: after.usageLearnersOnly },
          before,
          after,
        });
        return written ? after : null;
      });
      if (!ok) throw new InvalidTimeZoneError();
      return ok;
    },

    // ---------------------------------------------------------------- dashboards
    async learnerDashboard(ctx: RequestContext) {
      const tenantId = tenantOf(ctx);
      return db.withoutTenant((conn) => repo.learnerDashboard(conn, tenantId, ctx.userId));
    },
    async offeringDashboard(ctx: RequestContext, offeringId: string) {
      const a = spec(ctx, offeringId, 'progress.view_class');
      const r = await db.withTenant(a.tenantId, (tx) => repo.offeringDashboard(tx, a));
      assertAccess(r.acc);
      return r.data ?? {};
    },
    async teachingDashboard(ctx: RequestContext) {
      const tenantId = tenantOf(ctx);
      return db.withTenant(tenantId, (tx) => repo.teachingDashboard(tx, tenantId, ctx.userId));
    },
    async videoEngagement(ctx: RequestContext, offeringId: string, itemId: string) {
      const a = spec(ctx, offeringId, 'progress.view_class');
      const r = await db.withTenant(a.tenantId, (tx) => repo.videoEngagement(tx, a, itemId));
      assertAccess(r.acc);
      if (!r.data) throw new VideoItemNotFoundError();
      return r.data;
    },

    // ---------------------------------------------------------------- at-risk
    async atRisk(
      ctx: RequestContext,
      offeringId: string,
      q: { limit: number; after: string | null },
    ) {
      const a = spec(ctx, offeringId, 'atrisk.view');
      const page = await db.withTenant(a.tenantId, (tx) => repo.atRiskPage(tx, a, q));
      assertAccess(page.acc);
      const more = page.rows.length > q.limit;
      const rows = more ? page.rows.slice(0, q.limit) : page.rows;
      const last = rows.at(-1);
      return {
        asOf: page.asOf ? new Date(page.asOf).toISOString() : null,
        timeZone: page.tz,
        settings: { ...DEFAULT_AT_RISK, ...(page.settings as Partial<AtRiskSettings>) },
        items: mapAtRisk(page, rows),
        total: page.total,
        nextCursor: more && last ? (last.participantId as string) : null,
      };
    },
    /** CSV of the flagged learners: one line per rule that fired, with the evidence. */
    async *atRiskCsv(ctx: RequestContext, offeringId: string): AsyncGenerator<string> {
      let header = false;
      for await (const { page, rows } of atRiskRows(ctx, offeringId, config.csvPage)) {
        if (!header) {
          header = true;
          yield `﻿${csvLine(['Learner', 'Email', 'Rule', 'Summary', 'Evidence'])}`;
        }
        for (const l of mapAtRisk(page, rows))
          for (const r of l.rules)
            yield csvLine([l.displayName, l.email, r.rule, r.summary, r.evidence.join(' | ')]);
      }
    },
    async atRiskXlsx(ctx: RequestContext, offeringId: string): Promise<Readable> {
      async function* all(): AsyncGenerator<XlsxCell[]> {
        yield ['Learner', 'Email', 'Rule', 'Summary', 'Evidence'];
        let n = 0;
        for await (const { page, rows } of atRiskRows(ctx, offeringId, config.csvPage))
          for (const l of mapAtRisk(page, rows))
            for (const r of l.rules) {
              if (++n > REPORT_ROW_LIMIT) return;
              yield [l.displayName, l.email, r.rule, r.summary, r.evidence.join(' | ')];
            }
      }
      const it = all();
      const first = await it.next(); // the access check runs before any byte is sent
      async function* withFirst() {
        if (!first.done) yield first.value;
        yield* it;
      }
      return xlsxStream('At-risk learners', withFirst());
    },

    // ---------------------------------------------------------------- college reports
    reportTable,
    async activeUsers(ctx: RequestContext) {
      const tenantId = tenantOf(ctx);
      const r = await db.withTenant(tenantId, (tx) => repo.activeUsers(tx, tenantId));
      const row = r as {
        tz: string;
        today: string;
        dau: number;
        wau: number;
        mau: number;
        as_of: string | Date | null;
      };
      return { ...row, asOf: row.as_of ? new Date(row.as_of).toISOString() : null };
    },
    async reportCsv(
      ctx: RequestContext,
      id: ReportTableId,
      q: { scope?: string | undefined; days?: number | undefined },
    ): Promise<string> {
      const t = await reportTable(ctx, id, q);
      let out = `﻿${csvLine(t.columns.map((c) => c.label))}`;
      for (const r of t.rows)
        out += csvLine(
          t.columns.map((c) => {
            const v = r[c.key] ?? '';
            return c.kind === 'datetime' && v ? formatDay(v, t.timeZone) : v;
          }),
        );
      return out;
    },
    async reportXlsx(
      ctx: RequestContext,
      id: ReportTableId,
      q: { scope?: string | undefined; days?: number | undefined },
    ): Promise<Readable> {
      const t = await reportTable(ctx, id, q);
      const rows: XlsxCell[][] = [
        t.columns.map((c) => c.label),
        ...t.rows.map((r) =>
          t.columns.map((c) => {
            const v = r[c.key] ?? null;
            return c.kind === 'datetime' && v ? formatDay(v, t.timeZone) : v;
          }),
        ),
      ];
      return xlsxStream(t.title, rows);
    },

    // ---------------------------------------------------------------- the worker
    /**
     * One pass over the active colleges: each gets bounded refresh batches until nothing is left (at most `maxBatches` per
     * college per pass; the rest waits for the next pass). Marks written meanwhile stay marked.
     */
    async refreshRollups(opts: { signal?: AbortSignal; maxBatches?: number } = {}) {
      const maxBatches = opts.maxBatches ?? 20;
      const tenants = await db.withoutTenant((c) => repo.rollupTenants(c));
      let batches = 0;
      let remaining = 0;
      for (const tenantId of tenants) {
        for (let i = 0; i < maxBatches; i++) {
          if (opts.signal?.aborted) return { tenants: tenants.length, batches, remaining };
          const left = await db.withoutTenant((c) =>
            repo.rollupRun(c, tenantId, config.rollupBatch, clock()),
          );
          batches++;
          if (left === 0) break;
          if (i === maxBatches - 1) remaining += left;
        }
      }
      return { tenants: tenants.length, batches, remaining };
    },
    /** tests and the benchmark: refresh one college until nothing is left */
    async refreshTenant(tenantId: string, now?: Date): Promise<number> {
      let batches = 0;
      for (;;) {
        const left = await db.withoutTenant((c) =>
          repo.rollupRun(c, tenantId, config.rollupBatch, now ?? clock()),
        );
        batches++;
        if (left === 0 || batches > 10_000) return batches;
      }
    },
  };
}
export type AnalyticsService = ReturnType<typeof createAnalyticsService>;

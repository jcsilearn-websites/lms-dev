import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../test/fakes';
import { createBackgroundTasks } from '../../../core/background';
import type { RequestContext } from '../../../core/context';
import { ForbiddenError, NotFoundError } from '../../../core/errors';
import { newId } from '../../../core/uuid';
import { describeRules, formatDay } from '../analytics.atrisk';
import {
  InvalidTimeZoneError,
  ReportDisabledError,
  VideoItemNotFoundError,
} from '../analytics.errors';
import type { AnalyticsRepository } from '../analytics.repository';
import { REPORT_ROW_LIMIT } from '../analytics.repository';
import { createAnalyticsService, summaryOf } from '../analytics.service';

// Service rules with a fake repository (no database): settings merge and defaults, the zone refusal, report shaping and the row
// limit, access verdicts, the once-a-day activity write and the at-risk wording (rules and evidence, never a score or a rank).

const T = newId();
const U = newId();
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: U,
  tenantId: T,
  role: 'institution_admin',
  isPlatformAdmin: false,
  sessionId: 's1',
  email: 'a@x.test',
  displayName: 'A',
  ip: null,
  userAgent: null,
  ...over,
});

const fakeRepo = (o: Record<string, unknown> = {}) =>
  ({
    getSettings: vi.fn(async () => ({
      tz: 'Asia/Kolkata',
      atRisk: {},
      analytics: null,
      usage: null,
    })),
    lockSettings: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => true),
    activityTouch: vi.fn(async () => new Date(Date.now() + 3_600_000)),
    reportRows: vi.fn(),
    atRiskPage: vi.fn(),
    offeringDashboard: vi.fn(),
    videoEngagement: vi.fn(),
    rollupTenants: vi.fn(async () => []),
    rollupRun: vi.fn(async () => 0),
    ...o,
  }) as unknown as AnalyticsRepository;

function make(repo: AnalyticsRepository, now = () => new Date('2026-11-16T06:00:00Z')) {
  const db = fakeDb();
  const background = createBackgroundTasks((err) => {
    throw err;
  });
  const service = createAnalyticsService({
    db,
    analyticsRepo: repo,
    background,
    config: { csvPage: 2, activityCacheMax: 3, rollupBatch: 500 },
    now,
  });
  return { service, db, background };
}

describe('analytics settings', () => {
  it('fills every default when the college has stored nothing', async () => {
    const { service } = make(fakeRepo());
    const s = await service.getSettings(ctx());
    expect(s).toEqual({
      timeZone: 'Asia/Kolkata',
      atRisk: {
        behindEnabled: true,
        missedDeadlinesEnabled: true,
        missedDeadlines: 2,
        lowScoreEnabled: true,
        passMarkPercent: 40,
        inactiveEnabled: true,
        inactiveDays: 14,
      },
      showCourseHealth: true,
      courseHealthWeeks: 3,
      courseHealthBacklogDays: 14,
      usageMinActiveDays: 1,
      usageLearnersOnly: true,
    });
  });

  it('merges a partial patch over the stored values and passes before / after to the audited write', async () => {
    const repo = fakeRepo({
      getSettings: vi.fn(async () => ({
        tz: 'Europe/London',
        atRisk: { passMarkPercent: 50 },
        analytics: { showCourseHealth: false, courseHealthWeeks: 5 },
        usage: { minActiveDays: 3 },
      })),
    });
    const { service } = make(repo);
    const out = await service.updateSettings(ctx(), { atRisk: { inactiveDays: 21 } } as never);
    expect(out.timeZone).toBe('Europe/London');
    expect(out.atRisk.passMarkPercent).toBe(50);
    expect(out.atRisk.inactiveDays).toBe(21);
    expect(out.showCourseHealth).toBe(false);
    expect(out.courseHealthWeeks).toBe(5);
    expect(out.usageMinActiveDays).toBe(3);
    const call = (repo.setSettings as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call.before.atRisk.inactiveDays).toBe(14);
    expect(call.after.atRisk.inactiveDays).toBe(21);
    expect(call.analytics).toEqual({
      showCourseHealth: false,
      courseHealthWeeks: 5,
      courseHealthBacklogDays: 14,
    });
  });

  it('an unknown time zone is refused (the write reports nothing written)', async () => {
    const { service } = make(fakeRepo({ setSettings: vi.fn(async () => false) }));
    await expect(service.updateSettings(ctx(), { timeZone: 'Mars/Base' } as never)).rejects.toThrow(
      InvalidTimeZoneError,
    );
  });

  it('a caller without a college is refused before any database work', async () => {
    const { service, db } = make(fakeRepo());
    await expect(service.getSettings(ctx({ tenantId: null }))).rejects.toThrow(ForbiddenError);
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});

describe('report tables', () => {
  it('maps rows to the declared columns, converts numbers and keeps the zone and asOf', async () => {
    const repo = fakeRepo({
      reportRows: vi.fn(async () => ({
        rows: [
          {
            day: '2026-11-15',
            active_users: '12',
            active_learners: 10,
            video_minutes: '3.5',
            extra: 'x',
          },
        ],
        tz: 'Asia/Kolkata',
        asOf: '2026-11-16T05:55:00.000Z',
        disabled: false,
      })),
    });
    const { service } = make(repo);
    const t = await service.reportTable(ctx(), 'activity', {});
    expect(t.rows).toEqual([
      { day: '2026-11-15', active_users: 12, active_learners: 10, video_minutes: 3.5 },
    ]);
    expect(t.timeZone).toBe('Asia/Kolkata');
    expect(t.asOf).toBe('2026-11-16T05:55:00.000Z');
    expect(t.truncated).toBe(false);
    expect(t.summary).toContain('latest day had 12 active users');
  });

  it(`stops at ${REPORT_ROW_LIMIT} rows and says it was truncated`, async () => {
    const rows = Array.from({ length: REPORT_ROW_LIMIT + 1 }, (_, i) => ({
      metric: `m${i}`,
      value: i,
      unit: 'GB',
    }));
    const repo = fakeRepo({
      reportRows: vi.fn(async () => ({ rows, tz: 'UTC', asOf: null, disabled: false })),
    });
    const t = await make(repo).service.reportTable(ctx(), 'resources', {});
    expect(t.rows).toHaveLength(REPORT_ROW_LIMIT);
    expect(t.truncated).toBe(true);
  });

  it('course health switched off by the college is a refusal, not an empty table', async () => {
    const repo = fakeRepo({
      reportRows: vi.fn(async () => ({ rows: [], tz: 'UTC', asOf: null, disabled: true })),
    });
    await expect(make(repo).service.reportTable(ctx(), 'course-health', {})).rejects.toThrow(
      ReportDisabledError,
    );
  });

  it('the organisation title names the grouping; summaries never name a person', () => {
    expect(summaryOf('at-risk', [{ department: 'CSE' }])).toBe(
      'Learners flagged by the at-risk rules, counted per department (no names).',
    );
    expect(summaryOf('course-health', [])).toContain('No running course needs attention');
    expect(summaryOf('grading-backlog', [{}, {}])).toBe(
      '2 offerings have work waiting to be graded.',
    );
  });

  it('the CSV export puts formula-looking cells behind an apostrophe and dates in the college zone', async () => {
    const repo = fakeRepo({
      reportRows: vi.fn(async () => ({
        rows: [
          {
            course_code: '=HYPERLINK("x")',
            course: 'Maths',
            submissions: 1,
            attempts: 0,
            oldest_waiting: '2026-11-15T20:00:00Z',
          },
        ],
        tz: 'Asia/Kolkata',
        asOf: null,
        disabled: false,
      })),
    });
    const csv = await make(repo).service.reportCsv(ctx(), 'grading-backlog', {});
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).toContain('16 Nov 2026'); // 20:00 UTC is already the next day in Kolkata
  });
});

describe('access verdicts', () => {
  it('a non-participant gets the offering-not-found refusal from the access CTE verdict', async () => {
    const repo = fakeRepo({
      offeringDashboard: vi.fn(async () => ({
        acc: { id: 'o', visible: false, allowed: false },
        data: null,
      })),
    });
    await expect(
      make(repo).service.offeringDashboard(ctx({ role: 'member' }), newId()),
    ).rejects.toThrow(NotFoundError);
  });

  it('a video item that is not a video of this offering is 404', async () => {
    const repo = fakeRepo({
      videoEngagement: vi.fn(async () => ({
        acc: { id: 'o', visible: true, allowed: true },
        data: null,
      })),
    });
    await expect(make(repo).service.videoEngagement(ctx(), newId(), newId())).rejects.toThrow(
      VideoItemNotFoundError,
    );
  });
});

describe('activity: at most one write per session and local day', () => {
  it('writes once, then not again until the next local midnight the database returned', async () => {
    let now = new Date('2026-11-16T06:00:00Z');
    const repo = fakeRepo({ activityTouch: vi.fn(async () => new Date('2026-11-16T18:30:00Z')) });
    const { service, background } = make(repo, () => now);
    const auth = { sessionId: 's1', userId: U, tenantId: T };
    service.noteActivity(auth);
    service.noteActivity(auth);
    await background.drain();
    service.noteActivity(auth);
    await background.drain();
    expect(repo.activityTouch).toHaveBeenCalledTimes(1);
    now = new Date('2026-11-16T18:31:00Z');
    service.noteActivity(auth);
    await background.drain();
    expect(repo.activityTouch).toHaveBeenCalledTimes(2);
  });

  it('no college (admin host) records nothing; a failed write is retried on the next request', async () => {
    const touch = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(new Date('2026-11-17T00:00:00Z'));
    const repo = fakeRepo({ activityTouch: touch });
    const db = fakeDb();
    const errors: unknown[] = [];
    const background = createBackgroundTasks((e) => errors.push(e));
    const service = createAnalyticsService({
      db,
      analyticsRepo: repo,
      background,
      config: { csvPage: 2, activityCacheMax: 3, rollupBatch: 500 },
      now: () => new Date('2026-11-16T06:00:00Z'),
    });
    service.noteActivity({ sessionId: 'p', userId: U, tenantId: null });
    service.noteActivity({ sessionId: 's', userId: U, tenantId: T });
    await background.drain();
    expect(errors).toHaveLength(1);
    service.noteActivity({ sessionId: 's', userId: U, tenantId: T });
    await background.drain();
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('the per-session cache is bounded', async () => {
    const repo = fakeRepo();
    const { service, background } = make(repo);
    for (const s of ['a', 'b', 'c', 'd', 'e']) {
      service.noteActivity({ sessionId: s, userId: U, tenantId: T });
      await background.drain();
    }
    // 'a' was evicted (cap 3 + 1): it writes again
    service.noteActivity({ sessionId: 'a', userId: U, tenantId: T });
    await background.drain();
    expect(repo.activityTouch).toHaveBeenCalledTimes(6);
  });
});

describe('at-risk', () => {
  const settings = {
    behindEnabled: true,
    missedDeadlinesEnabled: true,
    missedDeadlines: 2,
    lowScoreEnabled: true,
    passMarkPercent: 40,
    inactiveEnabled: true,
    inactiveDays: 14,
  };

  it('words each rule that fired with its evidence, and nothing else', () => {
    const rules = describeRules(
      {
        behind: true,
        behindItems: [{ title: 'Week 1 video', since: '2026-11-01T00:00:00Z' }],
        missed: true,
        missedCount: 3,
        missedItems: [{ title: 'Essay', at: '2026-11-10T12:00:00Z' }],
        low: false,
        inactive: true,
        lastActivityAt: '2026-11-01T00:00:00Z',
      },
      settings,
      'Asia/Kolkata',
      new Date('2026-11-16T00:00:00Z'),
    );
    expect(rules.map((r) => r.rule)).toEqual(['behind', 'missed_deadlines', 'inactive']);
    expect(rules[0]?.evidence).toEqual(['Week 1 video: open since 1 Nov 2026, not done']);
    expect(rules[1]?.summary).toBe('Missed 3 deadlines (flagged from 2)');
    expect(rules[2]?.summary).toBe('No activity for 15 days (flagged from 14)');
    // no score, rank or risk number anywhere in the words
    expect(JSON.stringify(rules)).not.toMatch(/score|rank|risk/i);
  });

  it('formats an invalid date as empty text', () => {
    expect(formatDay('not a date', 'UTC')).toBe('');
  });

  it('pages: returns the cursor of the last row only when there is more', async () => {
    const row = (id: string) => ({
      participantId: id,
      displayName: id,
      email: `${id}@x`,
      inactive: false,
    });
    const repo = fakeRepo({
      atRiskPage: vi.fn(async () => ({
        acc: { id: 'o', visible: true, allowed: true },
        rows: [row('p1'), row('p2'), row('p3')],
        settings: {},
        tz: 'UTC',
        asOf: '2026-11-16T05:00:00Z',
        total: 3,
      })),
    });
    const page = await make(repo).service.atRisk(ctx(), newId(), { limit: 2, after: null });
    expect(page.items.map((i) => i.participantId)).toEqual(['p1', 'p2']);
    expect(page.nextCursor).toBe('p2');
    expect(page.items[0]?.rules).toEqual([]);
  });
});

describe('the worker', () => {
  it('refreshes each college in bounded batches and reports what is left', async () => {
    const t1 = newId();
    const t2 = newId();
    const left: Record<string, number[]> = { [t1]: [5, 0], [t2]: [7, 7, 7] };
    const repo = fakeRepo({
      rollupTenants: vi.fn(async () => [t1, t2]),
      rollupRun: vi.fn(async (_c: unknown, t: string) => left[t]?.shift() ?? 0),
    });
    const out = await make(repo).service.refreshRollups({ maxBatches: 3 });
    expect(out).toEqual({ tenants: 2, batches: 5, remaining: 7 });
  });

  it('stops between batches when the job is aborted', async () => {
    const ac = new AbortController();
    const repo = fakeRepo({
      rollupTenants: vi.fn(async () => [newId()]),
      rollupRun: vi.fn(async () => {
        ac.abort();
        return 10;
      }),
    });
    const out = await make(repo).service.refreshRollups({ signal: ac.signal, maxBatches: 50 });
    expect(out.batches).toBe(1);
  });
});

// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { addAssignment, handIn, inHours, setDates } from './assignments-helpers';
import { TestClient } from './client';
import {
  doc,
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  person,
  type Structure,
  structure,
} from './courses-helpers';
import { assignment, type Class, gradebookClass, participantIds, quiz } from './gradebook-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// Step 12: dashboards, at-risk rules with their evidence, visibility, the time zone, reports and exports, usage metering.
// (The rollup correctness property tests are in analytics.rollup.test.ts; budgets in query-budget.analytics.test.ts.)

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let admin: TestClient;
let adminB: TestClient;
let root: TestClient;
let st: Structure;
let e: Class;
let pids: string[];
let outsider: Awaited<ReturnType<typeof person>>;
let agedItem: Json;
let videoItem: Json;
let openWork: Json;
const L = { behind: 0, missed: 1, low: 2, idle: 3, fine: 4 } as const;

const ic = () => e.instructor.client;
const learner = (i: number) => e.learners[i]!;
const text = (c: TestClient, title: string, over: Json = {}) =>
  c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
    kind: 'text',
    title,
    body: doc('x'),
    published: true,
    ...over,
  });
const refresh = () => t.app.modules.analytics.service.refreshTenant(A.tenantId);

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'an-a');
  B = await createAuthFixture(owner, 'an-b');
  const plat = await createPlatformAdmin(owner, 'root@an.test');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  root = new TestClient(t, 'admin.localhost');
  expect((await root.login(plat.email, TEST_PASSWORD)).statusCode).toBe(200);
  st = await structure(admin);
  outsider = await person(owner, t, A, 'Outsider');
  e = await gradebookClass(owner, t, A, admin, st, ['Behind', 'Missed', 'Low', 'Idle', 'Fine']);
  pids = await participantIds(owner, e.offeringId, e.learners);

  // L1 hands in nothing: two missed deadlines. The others are graded and released; L2 scored 20 of 100.
  await assignment(owner, e, 'Essay A', [90, null, 20, 90, 90], { release: true, dueInPast: true });
  await assignment(owner, e, 'Essay B', [90, null, 20, 90, 90], { release: true, dueInPast: true });
  await quiz(e, 'Quiz One', [true, true, false, true, true]);
  // a required item open for 10 days that only L0 has not done
  agedItem = ok(await text(ic(), 'Notes aged'));
  await owner.query(
    `UPDATE lms.content_items SET created_at = now() - interval '10 days' WHERE id = $1`,
    [agedItem.id],
  );
  for (const i of [1, 2, 3, 4])
    await owner.query(
      `INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how)
       VALUES ($1,$2,$3,$4,'completed', now(), 'manual') ON CONFLICT (tenant_id, participant_id, item_id) DO UPDATE SET status='completed', completed_at=now(), completed_how='manual'`,
      [A.tenantId, pids[i], agedItem.id, e.offeringId],
    );
  // L3 went quiet 30 days ago: everything they did, and their enrolment, is old
  await owner.query(
    `UPDATE lms.course_participants SET created_at = now() - interval '30 days' WHERE id = $1`,
    [pids[L.idle]],
  );
  await owner.query(
    `UPDATE lms.submissions SET submitted_at = now() - interval '30 days' WHERE participant_id = $1`,
    [pids[L.idle]],
  );
  await owner.query(
    `UPDATE lms.attempts SET started_at = now() - interval '30 days', submitted_at = now() - interval '30 days' WHERE participant_id = $1`,
    [pids[L.idle]],
  );
  await owner.query(
    `UPDATE lms.item_progress SET last_activity_at = now() - interval '30 days', completed_at = now() - interval '30 days' WHERE participant_id = $1`,
    [pids[L.idle]],
  );
  // an open assignment (due in 48 h) and one ungraded hand-in (grading backlog)
  openWork = await addAssignment(e, { title: 'Open work' });
  await setDates(owner, openWork.id, { opensAt: null, dueAt: inHours(48), cutoffAt: null });
  ok(await handIn(e, learner(L.fine), openWork.id));
  // a 100 s video: L0 watched seconds 0-50, L1 all of it, nobody else started
  const videoId = newId();
  await owner.query(
    `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status, duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
     VALUES ($1,$2,$3,$4,'v.mp4',1000,'ready',100000,'x',now(),1000,100,$5::jsonb)`,
    [
      videoId,
      A.tenantId,
      e.offeringId,
      e.instructor.userId,
      JSON.stringify([
        { name: '360p', bytes: 1_000_000 },
        { name: '720p', bytes: 4_000_000 },
      ]),
    ],
  );
  videoItem = ok(await text(ic(), 'Lecture', { kind: 'video', videoId, body: undefined }));
  for (const [i, ranges] of [
    [0, '{[0,50)}'],
    [1, '{[0,100)}'],
  ] as const)
    await owner.query(
      `INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id, ranges, watched_seconds, duration_s)
       VALUES ($1,$2,$3,$4,$5::int4multirange, 50, 100)`,
      [A.tenantId, pids[i], videoItem.id, e.offeringId, ranges],
    );
  await refresh();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const atRisk = async (c: TestClient, qs = '') => c.get(`/offerings/${e.offeringId}/at-risk${qs}`);
const flagged = async () => {
  const body = ok(await atRisk(ic()));
  return Object.fromEntries(
    body.items.map((i: Json) => [i.displayName, i.rules.map((r: Json) => r.rule).sort()]),
  ) as Record<string, string[]>;
};

describe('at-risk rules: each one fires alone, with its evidence', () => {
  it('flags exactly the learners a rule catches, and names the rule', async () => {
    expect(await flagged()).toEqual({
      Behind: ['behind'],
      Missed: ['missed_deadlines'],
      Low: ['low_score'],
      Idle: ['inactive'],
    });
  });

  it('shows the evidence in words: which items, which dates, which scores', async () => {
    const body = ok(await atRisk(ic()));
    const by = (n: string) => body.items.find((i: Json) => i.displayName === n);
    expect(by('Behind').rules[0].evidence.join(' ')).toContain('Notes aged');
    const missed = by('Missed').rules[0];
    expect(missed.summary).toContain('Missed 2 deadlines');
    expect(missed.evidence.join(' ')).toMatch(/Essay A.*due .*nothing handed in/);
    expect(missed.evidence.join(' ')).toContain('Essay B');
    const low = by('Low').rules[0];
    expect(low.summary).toContain('below the pass mark of 40%');
    expect(low.evidence.join(' ')).toContain('Essay A: 20.0%');
    expect(by('Idle').rules[0].evidence[0]).toMatch(/Last activity|No activity since/);
    expect(body.timeZone).toBe('Asia/Kolkata');
    expect(body.asOf).toBeTruthy();
  });

  it('has no risk score anywhere: only the rules that fired', async () => {
    const text = JSON.stringify(ok(await atRisk(ic())));
    expect(text).not.toMatch(/risk[_ ]?score|"score"|probability|ranking/i);
  });

  it("the thresholds are the college's: a lower pass mark un-flags the low scorer, with no refresh needed", async () => {
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { atRisk: { passMarkPercent: 10 } },
      }),
    );
    expect((await flagged()).Low).toBeUndefined();
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { atRisk: { passMarkPercent: 40, missedDeadlines: 3 } },
      }),
    );
    expect((await flagged()).Missed).toBeUndefined(); // 2 missed, flagged from 3
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { atRisk: { missedDeadlines: 2, inactiveEnabled: false } },
      }),
    );
    const f = await flagged();
    expect(f.Missed).toEqual(['missed_deadlines']);
    expect(f.Idle).toBeUndefined();
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { atRisk: { inactiveEnabled: true } },
      }),
    );
    expect((await flagged()).Idle).toEqual(['inactive']);
  });

  it('exports CSV (one line per rule, with evidence) and XLSX', async () => {
    const csv = await ic().get(`/offerings/${e.offeringId}/at-risk.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('Learner,Email,Rule,Summary,Evidence');
    expect(csv.body).toMatch(/Missed,.*missed_deadlines.*Essay A/);
    const x = await ic().get(`/offerings/${e.offeringId}/at-risk.xlsx`);
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('visibility', () => {
  it('learners never see the at-risk list, its export, or any at-risk field of their own', async () => {
    for (const url of ['at-risk', 'at-risk.csv', 'at-risk.xlsx'])
      expect(
        (await learner(L.low).client.get(`/offerings/${e.offeringId}/${url}`)).statusCode,
      ).toBe(403);
    const dash = (await learner(L.low).client.get('/me/dashboard')).body;
    expect(dash).not.toMatch(/risk|flagged|behind/i);
    const progress = (await learner(L.low).client.get(`/offerings/${e.offeringId}/progress`)).body;
    expect(progress).not.toMatch(/at.?risk|flagged/i);
  });

  it('instructor, assistant and institution admin see it; a member outside the offering gets 404; another college 401', async () => {
    expect((await atRisk(e.assistant.client)).statusCode).toBe(200);
    expect((await atRisk(admin)).statusCode).toBe(200);
    const o = await atRisk(outsider.client);
    expect(o.statusCode).toBe(404);
    expect(errorCode(o)).toBe('offering_not_found');
    // an admin of another college asks at THEIR host: this offering does not exist there
    expect((await atRisk(adminB)).statusCode).toBe(404);
  });

  it('an instructor of one offering cannot read another offering (404), and the teaching dashboard lists only their own', async () => {
    const other = await newCourse(admin);
    const off = await newOffering(admin, other.id, st.termId);
    await owner.query(`UPDATE lms.course_offerings SET status = 'published' WHERE id = $1`, [
      off.id,
    ]);
    expect((await ic().get(`/offerings/${off.id}/at-risk`)).statusCode).toBe(404);
    expect((await ic().get(`/offerings/${off.id}/dashboard`)).statusCode).toBe(404);
    const mine = ok(await ic().get('/me/teaching/dashboard'));
    expect(mine.offerings.map((o: Json) => o.offeringId)).toEqual([e.offeringId]);
    expect(ok(await learner(L.fine).client.get('/me/teaching/dashboard')).offerings).toEqual([]);
  });

  it('platform admin gets aggregates only; college users and the platform are walled off from each other', async () => {
    const res = ok(await root.get('/platform/usage'));
    expect(Object.keys(res.rows[0]).sort()).toEqual(
      [
        'activeOfferings',
        'activeUsers',
        'billableLearners',
        'members',
        'name',
        'offerings',
        'provisional',
        'revision',
        'slug',
        'status',
        'storageGb',
        'tenantId',
        'timeZone',
        'videoGbEstimate',
        'videoHours',
      ].sort(),
    );
    expect(JSON.stringify(res)).not.toMatch(/Asha|Behind|@an-a/);
    expect((await admin.get('/platform/usage')).statusCode).toBe(403);
    expect((await root.get('/reports/activity')).statusCode).toBe(403); // a platform admin has no college permission
  });
});

describe('instructor dashboards', () => {
  it('one offering: backlog, upcoming, funnel, assessments, recent activity, flagged count', async () => {
    const d = ok(await ic().get(`/offerings/${e.offeringId}/dashboard`));
    expect(d.learners).toBe(5);
    expect(d.backlog.submissions).toBe(1); // the hand-in of "Open work" is waiting for a grade
    expect(d.upcoming.map((u: Json) => u.title)).toContain('Open work');
    expect(d.funnel).toHaveLength(1);
    expect(d.funnel[0].requiredItems).toBeGreaterThan(3);
    expect(d.funnel[0].started).toBeGreaterThan(0);
    expect(d.assessments.map((a: Json) => a.title)).toContain('Quiz One');
    const quiz1 = d.assessments.find((a: Json) => a.title === 'Quiz One');
    expect(quiz1.attempts).toBe(5);
    expect(d.atRiskCount).toBe(4);
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.asOf).toBeTruthy();
    expect((await learner(0).client.get(`/offerings/${e.offeringId}/dashboard`)).statusCode).toBe(
      403,
    );
  });

  it('video drop-off: the share of ALL learners covering each segment, aggregate only', async () => {
    const v = ok(await ic().get(`/offerings/${e.offeringId}/videos/${videoItem.id}/engagement`));
    expect(v).toMatchObject({ durationSeconds: 100, learners: 5, started: 2 });
    const at = (s: number) =>
      v.segments.find((x: Json) => x.fromSecond <= s && s < x.toSecond).percent;
    expect(at(10)).toBe(40); // L0 and L1 of 5
    expect(at(70)).toBe(20); // only L1
    expect(JSON.stringify(v)).not.toMatch(/Behind|Missed|participant/);
    const notVideo = await ic().get(`/offerings/${e.offeringId}/videos/${agedItem.id}/engagement`);
    expect(notVideo.statusCode).toBe(404);
    expect(
      (await learner(0).client.get(`/offerings/${e.offeringId}/videos/${videoItem.id}/engagement`))
        .statusCode,
    ).toBe(403);
  });
});

describe('learner dashboard', () => {
  it('shows what is coming up, released grades, where to continue, the week and the streak: all of their own', async () => {
    const dash = ok(await learner(L.fine).client.get('/me/dashboard'));
    expect(dash.timeZone).toBe('Asia/Kolkata');
    expect(dash.week).toHaveLength(7);
    // "Open work" is due in 48 h but this learner already handed it in: it is not "upcoming"
    expect(dash.upcoming.map((u: Json) => u.title)).not.toContain('Open work');
    const dash0 = ok(await learner(L.behind).client.get('/me/dashboard'));
    expect(dash0.upcoming.map((u: Json) => u.title)).toContain('Open work');
    expect(dash0.released.map((r: Json) => r.title)).toEqual(
      expect.arrayContaining(['Essay A', 'Essay B']),
    );
    // one learner's list never mentions another learner's work
    expect(JSON.stringify(dash0)).not.toMatch(/Missed|Low|Idle|Fine/);
  });

  it('the streak counts consecutive local days with activity, and is private to the learner', async () => {
    const who = learner(L.fine);
    for (const d of [0, 1, 2, 4])
      await owner.query(
        `INSERT INTO lms.member_activity_days (tenant_id, user_id, day) VALUES ($1,$2, lms.local_day(now(), 'Asia/Kolkata') - $3::int) ON CONFLICT DO NOTHING`,
        [A.tenantId, who.userId, d],
      );
    const dash = ok(await who.client.get('/me/dashboard'));
    expect(dash.streak).toBe(3); // today, yesterday, the day before; day 3 is a gap
    // nothing of it reaches anyone else's responses
    expect(
      JSON.stringify(ok(await ic().get(`/offerings/${e.offeringId}/dashboard`))),
    ).not.toContain('streak');
  });
});

describe('time zone', () => {
  it('rejects a zone the database does not know, and audits a change with before and after', async () => {
    const bad = await admin.request('PATCH', '/analytics/settings', {
      body: { timeZone: 'Mars/Olympus' },
    });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe('invalid_time_zone');
    expect(
      (await e.learners[0]!.client.request('PATCH', '/analytics/settings', { body: {} }))
        .statusCode,
    ).toBe(403);
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { timeZone: 'America/New_York' },
      }),
    );
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE tenant_id=$1 AND action='analytics.settings_changed' ORDER BY id DESC LIMIT 1`,
      [A.tenantId],
    );
    expect(rows[0].metadata.before.timeZone).toBe('Asia/Kolkata');
    expect(rows[0].metadata.after.timeZone).toBe('America/New_York');
    expect(ok(await admin.get('/analytics/settings')).timeZone).toBe('America/New_York');
    ok(await admin.request('PATCH', '/analytics/settings', { body: { timeZone: 'Asia/Kolkata' } }));
  });

  const day = async (iso: string, tz: string) =>
    (await owner.query(`SELECT lms.local_day($1::timestamptz, $2)::text AS d`, [iso, tz])).rows[0]
      .d as string;
  const midnight = async (iso: string, tz: string) =>
    new Date(
      (await owner.query(`SELECT lms.next_local_midnight($1::timestamptz, $2) AS m`, [iso, tz]))
        .rows[0].m,
    ).toISOString();

  it('buckets by the LOCAL day at midnight boundaries (IST is +05:30)', async () => {
    expect(await day('2026-03-01T18:29:59Z', 'Asia/Kolkata')).toBe('2026-03-01');
    expect(await day('2026-03-01T18:30:00Z', 'Asia/Kolkata')).toBe('2026-03-02');
    expect(await midnight('2026-03-01T10:00:00Z', 'Asia/Kolkata')).toBe('2026-03-01T18:30:00.000Z');
    expect(await day('2026-03-01T04:59:59Z', 'America/New_York')).toBe('2026-02-28');
    expect(await day('2026-03-01T05:00:00Z', 'America/New_York')).toBe('2026-03-01');
  });

  it('is DST-safe: the day after spring-forward is 23 h long and autumn-fall-back 25 h', async () => {
    // New York: 2026-03-08 02:00 -> 03:00 (clocks forward); 2026-11-01 02:00 -> 01:00 (back)
    expect(await midnight('2026-03-08T12:00:00Z', 'America/New_York')).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    expect(await midnight('2026-03-07T12:00:00Z', 'America/New_York')).toBe(
      '2026-03-08T05:00:00.000Z',
    ); // 23 h day follows
    expect(await midnight('2026-11-01T12:00:00Z', 'America/New_York')).toBe(
      '2026-11-02T05:00:00.000Z',
    );
    expect(await midnight('2026-10-31T12:00:00Z', 'America/New_York')).toBe(
      '2026-11-01T04:00:00.000Z',
    ); // 25 h day follows
  });

  it('activity: ONE row per local day, whatever the number of calls; the next call is after the next midnight', async () => {
    const who = learner(L.fine).userId;
    const touch = async (iso: string) =>
      new Date(
        (
          await owner.query(`SELECT lms.activity_touch($1,$2,$3::timestamptz) AS n`, [
            A.tenantId,
            who,
            iso,
          ])
        ).rows[0].n,
      ).toISOString();
    const days = async () =>
      (
        await owner.query(
          `SELECT day::text FROM lms.member_activity_days WHERE tenant_id=$1 AND user_id=$2 AND day >= '2030-01-01' ORDER BY day`,
          [A.tenantId, who],
        )
      ).rows.map((r) => r.day);
    expect(await touch('2030-05-01T18:29:00Z')).toBe('2030-05-01T18:30:00.000Z'); // IST: still 1 May, midnight in a minute
    await touch('2030-05-01T18:29:30Z');
    expect(await days()).toEqual(['2030-05-01']);
    await touch('2030-05-01T18:31:00Z'); // 00:01 IST on 2 May
    expect(await days()).toEqual(['2030-05-01', '2030-05-02']);
  });

  it('through the API: the first request of the day writes once, later requests cost nothing', async () => {
    const svc = t.app.modules.analytics.service;
    svc.resetActivityCache();
    const who = learner(L.behind);
    const count = async () =>
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM lms.member_activity_days WHERE tenant_id=$1 AND user_id=$2 AND day = lms.local_day(now(), lms.tenant_tz($1))`,
          [A.tenantId, who.userId],
        )
      ).rows[0].n as number;
    await owner.query(
      `DELETE FROM lms.member_activity_days WHERE tenant_id=$1 AND user_id=$2 AND day = lms.local_day(now(), lms.tenant_tz($1))`,
      [A.tenantId, who.userId],
    );
    t.statements.reset();
    ok(await who.client.get('/me/dashboard'));
    await t.app.modules.background.drain();
    const first = t.statements.raw.filter((s) => s.includes('activity_touch')).length;
    for (let i = 0; i < 5; i++) ok(await who.client.get('/me/dashboard'));
    await t.app.modules.background.drain();
    const total = t.statements.raw.filter((s) => s.includes('activity_touch')).length;
    expect(first).toBe(1);
    expect(total).toBe(1);
    expect(await count()).toBe(1);
    // polling does not count as being active
    svc.resetActivityCache();
    await owner.query(
      `DELETE FROM lms.member_activity_days WHERE tenant_id=$1 AND user_id=$2 AND day = lms.local_day(now(), lms.tenant_tz($1))`,
      [A.tenantId, who.userId],
    );
    ok(await who.client.get('/auth/me'));
    await t.app.modules.background.drain();
    expect(await count()).toBe(0);
  });
});

describe('college reports and exports', () => {
  const TABLES = [
    'activity',
    'organisation',
    'course-health',
    'gradebooks',
    'grading-backlog',
    'at-risk',
    'resources',
  ];

  it('every table has columns, rows, a summary sentence, the time zone and (where rollups are used) a data-as-of time', async () => {
    for (const id of TABLES) {
      const r = ok(await admin.get(`/reports/${id}`));
      expect(r.id).toBe(id);
      expect(r.columns.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.timeZone).toBe('Asia/Kolkata');
      for (const row of r.rows)
        expect(Object.keys(row).sort()).toEqual(r.columns.map((c: Json) => c.key).sort());
    }
    const activity = ok(await admin.get('/reports/activity', { query: 'days=14' }));
    expect(activity.rows).toHaveLength(14);
    expect(ok(await admin.get('/reports/activity')).asOf).toBeTruthy();
  });

  it('completion and scores by organisation, at-risk counts by department (counts only), grading backlog', async () => {
    const org = ok(await admin.get('/reports/organisation', { query: 'scope=section' }));
    expect(org.rows.length).toBeGreaterThan(0);
    const total = org.rows.reduce((a: number, r: Json) => a + r.learners, 0);
    expect(total).toBeGreaterThanOrEqual(5);
    const risk = ok(await admin.get('/reports/at-risk'));
    expect(risk.rows.reduce((a: number, r: Json) => a + r.flagged_learners, 0)).toBe(4);
    for (const l of e.learners) expect(JSON.stringify(risk)).not.toContain(l.email); // no names, no addresses
    const backlog = ok(await admin.get('/reports/grading-backlog'));
    expect(backlog.rows.reduce((a: number, r: Json) => a + r.submissions, 0)).toBe(1);
  });

  it('active users: DAU / WAU / MAU in the college zone', async () => {
    const a = ok(await admin.get('/reports/active-users'));
    expect(a.dau).toBeGreaterThan(0);
    expect(a.wau).toBeGreaterThanOrEqual(a.dau);
    expect(a.mau).toBeGreaterThanOrEqual(a.wau);
  });

  it('is limited to the college: another college sees none of this, a member sees nothing', async () => {
    const b = ok(await adminB.get('/reports/at-risk'));
    expect(b.rows.reduce((a: number, r: Json) => a + r.flagged_learners, 0)).toBe(0);
    expect(ok(await adminB.get('/reports/gradebooks')).rows).toEqual([]);
    expect((await learner(0).client.get('/reports/activity')).statusCode).toBe(403);
    expect(
      (await learner(0).client.get('/reports/activity/export', { query: 'format=csv' })).statusCode,
    ).toBe(403);
  });

  it('exports every table as CSV and XLSX; formulas in cells are neutralised', async () => {
    for (const id of TABLES) {
      const csv = await admin.get(`/reports/${id}/export`, { query: 'format=csv' });
      expect(csv.statusCode, id).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body.startsWith('﻿')).toBe(true);
      const x = await admin.get(`/reports/${id}/export`, { query: 'format=xlsx' });
      expect(x.statusCode, id).toBe(200);
      expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    }
    // a department named like a formula must come out with an apostrophe
    await owner.query(
      `UPDATE lms.departments SET name = '=HYPERLINK("http://evil")' WHERE id = (SELECT id FROM lms.departments WHERE tenant_id = $1 LIMIT 1)`,
      [A.tenantId],
    );
    const csv = await admin.get('/reports/at-risk/export', { query: 'format=csv' });
    expect(csv.body).toContain(`'=HYPERLINK`);
    expect(csv.body).not.toMatch(/(^|\r\n)=HYPERLINK/);
  });
});

describe('usage metering', () => {
  const month = new Date().toISOString().slice(0, 7);
  const first = `${month}-01`;
  const mix = { '360p': 0.2, '480p': 0.3, '720p': 0.5 };
  let assetId: string;

  const rowOf = (res: Json, slug: string) => res.rows.find((r: Json) => r.slug === slug);

  it('computes billable learners, video hours, estimated GB, storage and offerings', async () => {
    // activity: three learners (two days for one), an instructor; a learner of B is separate
    for (const [i, d] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
    ] as const)
      await owner.query(
        `INSERT INTO lms.member_activity_days (tenant_id, user_id, day) VALUES ($1,$2, lms.local_day(now(), 'Asia/Kolkata') - $3::int) ON CONFLICT DO NOTHING`,
        [A.tenantId, learner(i).userId, d],
      );
    await owner.query(
      `INSERT INTO lms.member_activity_days (tenant_id, user_id, day) VALUES ($1,$2, lms.local_day(now(), 'Asia/Kolkata')) ON CONFLICT DO NOTHING`,
      [A.tenantId, e.instructor.userId],
    );
    // 2000 s watched of a 100 s video whose 360p is 1 MB and 720p 4 MB (no 480p: the mix is re-weighted over what exists)
    assetId = (
      await owner.query(`SELECT video_asset_id AS id FROM lms.content_items WHERE id = $1`, [
        videoItem.id,
      ])
    ).rows[0].id;
    await owner.query(
      `INSERT INTO lms.video_watch_days (tenant_id, participant_id, item_id, asset_id, day, seconds)
       VALUES ($1,$2,$3,$4, lms.local_day(now(), 'Asia/Kolkata'), 2000) ON CONFLICT (tenant_id, participant_id, item_id, asset_id, day) DO UPDATE SET seconds = 2000`,
      [A.tenantId, pids[0], videoItem.id, assetId],
    );
    const res = ok(await root.get('/platform/usage', { query: `month=${first}` }));
    const a = rowOf(res, A.slug);
    expect(a.provisional).toBe(true);
    // distinct active users this month >= 4 (days may fall in last month on the 1st: count only today's rows)
    expect(a.activeUsers).toBeGreaterThanOrEqual(4);
    expect(a.billableLearners).toBeGreaterThanOrEqual(3); // the instructor is not a learner
    expect(a.videoHours).toBeCloseTo(2000 / 3600, 2);
    // (0.2 * 10,000 + 0.5 * 40,000) / 0.7 = 31,428.571 B/s x 2000 s = 62.857 MB
    expect(a.videoGbEstimate).toBeCloseTo(0.063, 3);
    expect(a.storageGb).toBeGreaterThan(0);
    expect(a.offerings).toBeGreaterThanOrEqual(1);
    expect(res.renditionMix).toEqual(mix);
    expect(res.note).toMatch(/estimate/i);
  });

  it("the billing definition is the college's: a minimum number of active days", async () => {
    ok(await admin.request('PATCH', '/analytics/settings', { body: { usageMinActiveDays: 2 } }));
    const res = ok(await root.get('/platform/usage', { query: `month=${first}` }));
    const n = rowOf(res, A.slug).billableLearners;
    ok(await admin.request('PATCH', '/analytics/settings', { body: { usageMinActiveDays: 1 } }));
    const after = rowOf(
      ok(await root.get('/platform/usage', { query: `month=${first}` })),
      A.slug,
    ).billableLearners;
    expect(n).toBeLessThan(after);
    ok(await admin.request('PATCH', '/analytics/settings', { body: { usageLearnersOnly: false } }));
    const all = rowOf(
      ok(await root.get('/platform/usage', { query: `month=${first}` })),
      A.slug,
    ).billableLearners;
    expect(all).toBeGreaterThan(after); // the instructor counts when learnersOnly is off
    ok(await admin.request('PATCH', '/analytics/settings', { body: { usageLearnersOnly: true } }));
  });

  it('closes a month into an immutable snapshot, once; later activity does not change it', async () => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const after = new Date(Date.UTC(y, m, 1, 3)).toISOString(); // 03:00 UTC on the 1st of next month
    const closed = (
      await owner.query(`SELECT lms.usage_close_due($1::timestamptz, $2::jsonb) AS n`, [
        after,
        JSON.stringify(mix),
      ])
    ).rows[0].n;
    expect(closed).toBeGreaterThanOrEqual(2); // both colleges
    expect(
      (
        await owner.query(`SELECT lms.usage_close_due($1::timestamptz, $2::jsonb) AS n`, [
          after,
          JSON.stringify(mix),
        ])
      ).rows[0].n,
    ).toBe(0);
    const before = rowOf(
      ok(await root.get('/platform/usage', { query: `month=${first}` })),
      A.slug,
    );
    expect(before.provisional).toBe(false);
    expect(before.revision).toBe(1);
    // more activity and more video after the close: the frozen month does not move
    await owner.query(
      `INSERT INTO lms.member_activity_days (tenant_id, user_id, day) VALUES ($1,$2, lms.local_day(now(), 'Asia/Kolkata')) ON CONFLICT DO NOTHING`,
      [A.tenantId, learner(4).userId],
    );
    await owner.query(
      `UPDATE lms.video_watch_days SET seconds = 9999 WHERE tenant_id = $1 AND asset_id = $2`,
      [A.tenantId, assetId],
    );
    const again = rowOf(ok(await root.get('/platform/usage', { query: `month=${first}` })), A.slug);
    expect(again).toEqual(before);
    // nobody can change or delete a snapshot: not the application role, not even the owner
    for (const pool of [owner]) {
      await expect(
        pool.query(`UPDATE lms.usage_snapshots SET billable_learners = 0 WHERE tenant_id = $1`, [
          A.tenantId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        pool.query(`DELETE FROM lms.usage_snapshots WHERE tenant_id = $1`, [A.tenantId]),
      ).rejects.toMatchObject({ code: '55000' });
    }
    const snap = (
      await owner.query(
        `SELECT rendition_mix, definition, time_zone FROM lms.usage_snapshots WHERE tenant_id=$1 AND month=$2`,
        [A.tenantId, first],
      )
    ).rows[0];
    expect(snap.rendition_mix).toEqual(mix);
    expect(snap.time_zone).toBe('Asia/Kolkata');
  });

  it('exports the month as CSV and XLSX (platform only)', async () => {
    const csv = await root.get('/platform/usage/export', { query: `format=csv&month=${first}` });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Billable learners');
    expect(csv.body).toContain(A.slug);
    expect(csv.body).toMatch(/closed \(revision 1\)/);
    const x = await root.get('/platform/usage/export', { query: `format=xlsx&month=${first}` });
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await admin.get('/platform/usage/export', { query: 'format=csv' })).statusCode).toBe(
      403,
    );
    expect((await root.get('/platform/usage', { query: 'month=2026-05-15' })).statusCode).toBe(400);
  });
});

describe('Needs attention (course health)', () => {
  const health = (c: TestClient = admin) => c.get('/reports/course-health');
  const mine = (t: Json) => t.rows.find((r: Json) => r.learners === 5);

  it('lists a course whose content is old or whose oldest ungraded work has waited, with the REASON, and never frames it as a person metric', async () => {
    await owner.query(
      `UPDATE lms.terms SET start_date = '2026-06-01', end_date = '2027-05-31' WHERE tenant_id = $1`,
      [A.tenantId],
    );
    await owner.query(
      `UPDATE lms.content_items SET created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE offering_id = $1`,
      [e.offeringId],
    );
    await owner.query(
      `UPDATE lms.submissions SET submitted_at = now() - interval '20 days' WHERE offering_id = $1 AND assignment_item_id = $2`,
      [e.offeringId, openWork.id],
    );
    const t = ok(await health());
    expect(t.title).toBe('Needs attention');
    expect(t.columns.map((c: Json) => c.label)).toContain('Why it needs attention');
    const row = mine(t);
    expect(row.attention).toBe('No new content in 3 weeks; Grading backlog older than 14 days');
    expect(row.oldest_waiting_days).toBeGreaterThanOrEqual(20);
    // about a course, not a person: no instructor, no learner, no performance wording
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/performance|productiv|faculty|instructor|@an-a/i);
    for (const l of e.learners) expect(text).not.toContain(l.email);
    expect(text).not.toContain(e.instructor.email);
    expect(t.summary).toMatch(/not about any person/);
  });

  it('is for institution administrators ONLY: instructors, assistants and learners get 403 (also for the export)', async () => {
    for (const c of [ic(), e.assistant.client, learner(L.fine).client, outsider.client]) {
      expect((await health(c)).statusCode).toBe(403);
      expect(
        (await c.get('/reports/course-health/export', { query: 'format=csv' })).statusCode,
      ).toBe(403);
    }
    expect((await health()).statusCode).toBe(200);
  });

  it("thresholds are the college's: a longer window and a longer wait drop the course from the list", async () => {
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { courseHealthWeeks: 26, courseHealthBacklogDays: 90 },
      }),
    );
    expect(mine(ok(await health()))).toBeUndefined();
    ok(
      await admin.request('PATCH', '/analytics/settings', {
        body: { courseHealthWeeks: 3, courseHealthBacklogDays: 14 },
      }),
    );
    expect(mine(ok(await health()))).toBeDefined();
  });

  it('is behind a college setting (default ON): switched off it answers 404 report_disabled, for the table and the export, and the change is audited', async () => {
    expect(ok(await admin.get('/analytics/settings')).showCourseHealth).toBe(true);
    ok(await admin.request('PATCH', '/analytics/settings', { body: { showCourseHealth: false } }));
    const off = await health();
    expect(off.statusCode).toBe(404);
    expect(errorCode(off)).toBe('report_disabled');
    expect(
      (await admin.get('/reports/course-health/export', { query: 'format=xlsx' })).statusCode,
    ).toBe(404);
    // every other report is unaffected
    expect((await admin.get('/reports/at-risk')).statusCode).toBe(200);
    const { rows } = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE tenant_id = $1 AND action = 'analytics.settings_changed' ORDER BY id DESC LIMIT 1`,
      [A.tenantId],
    );
    expect(rows[0].metadata.before.showCourseHealth).toBe(true);
    expect(rows[0].metadata.after.showCourseHealth).toBe(false);
    expect(
      (
        await e.learners[0]!.client.request('PATCH', '/analytics/settings', {
          body: { showCourseHealth: true },
        })
      ).statusCode,
    ).toBe(403);
    ok(await admin.request('PATCH', '/analytics/settings', { body: { showCourseHealth: true } }));
    expect((await health()).statusCode).toBe(200);
  });
});

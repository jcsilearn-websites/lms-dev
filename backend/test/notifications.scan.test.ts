import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addAssessment, addQuestion, fixed, q, startAttempt, submit } from './assessments-helpers';
import { addAssignment, base, exam, handIn, inHours, setDates } from './assignments-helpers';
import { deliverEmails, TestClient } from './client';
import { type Json, loginAs, ok, type Structure, uniq } from './courses-helpers';
import {
  notificationsOf,
  outboxOf,
  participantOf,
  quietOff,
  setNotifySettings,
} from './notifications-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 13: the scan (one statement per college): deadline reminders 24 h / 1 h ONLY to learners who have not handed in,
// quizzes opening / closing, results visible by the clock, the daily digests and the weekly summaries in the COLLEGE'S time
// zone, quiet hours. The scan takes the instant to act at, so time is simulated without touching the clock.

let owner: pg.Pool;
let t: TestApp;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** An academic year and term around TODAY (the shared helper's term has fixed dates). */
async function currentStructure(admin: TestClient): Promise<Structure> {
  const now = new Date();
  const year = ok(
    await admin.post('/academic-years', {
      label: uniq('Y'),
      startDate: day(addDays(now, -60)),
      endDate: day(addDays(now, 300)),
    }),
  );
  const term = ok(
    await admin.post('/terms', {
      academicYearId: year.id,
      name: uniq('Sem'),
      startDate: day(addDays(now, -30)),
      endDate: day(addDays(now, 120)),
    }),
  );
  const dept = ok(
    await admin.post('/departments', { code: uniq('D').toUpperCase(), name: 'Computing' }),
  );
  const prog = ok(
    await admin.post('/programs', {
      departmentId: dept.id,
      code: uniq('P').toUpperCase(),
      name: 'B.Sc.',
      durationYears: 3,
    }),
  );
  const batch = ok(
    await admin.post('/batches', { programId: prog.id, admissionYear: 2026, graduationYear: 2029 }),
  );
  const a = ok(await admin.post('/sections', { batchId: batch.id, code: 'A' }));
  const b = ok(await admin.post('/sections', { batchId: batch.id, code: 'B' }));
  return {
    termId: term.id,
    yearId: year.id,
    deptId: dept.id,
    programId: prog.id,
    batchId: batch.id,
    sectionA: a.id,
    sectionB: b.id,
  };
}

/** A fresh college (its own scan state), quiet hours off. */
async function college(prefix: string) {
  const A: AuthFixture = await createAuthFixture(owner, uniq(prefix));
  await quietOff(owner, A.tenantId);
  const admin = await loginAs(t, A.host, A.adminEmail);
  const st = await currentStructure(admin);
  const scan = (now: Date) => t.app.modules.notifications.service.scanTenant(A.tenantId, now);
  return { A, admin, st, scan };
}

/** "HH:MM" of an instant in a zone. */
const hhmm = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

/** The instant of a LOCAL wall time on the local date of `ref` + `days` (zone-aware, via the database). */
async function localInstant(ref: Date, days: number, time: string, tz: string): Promise<Date> {
  const { rows } = await owner.query(
    `SELECT ((($1::timestamptz AT TIME ZONE $3)::date + $2::int) + $4::time) AT TIME ZONE $3 AS at`,
    [ref.toISOString(), days, tz, time],
  );
  return new Date(rows[0].at);
}

describe('assignment due reminders', () => {
  it('1 hour before: only learners who handed in nothing, never removed ones; an extension moves the reminder; repeats are no-ops', async () => {
    const { A, admin, st, scan } = await college('ntf-due');
    const e = await exam(owner, t, A, admin, st, 4);
    const [a, b, c, d] = e.learners as [Json, Json, Json, Json];
    const now = new Date();
    const due = new Date(now.getTime() + 58 * 60_000); // its 1-hour threshold was two minutes ago
    const item = await addAssignment(e, {
      title: 'Lab report',
      settings: { dueAt: due.toISOString() },
    });
    ok(await handIn(e, a, item.id));
    ok(
      await admin.delete(
        `/offerings/${e.offeringId}/participants/${await participantOf(owner, e.offeringId, c.userId)}`,
      ),
    );
    const dExt = new Date(now.getTime() + 5 * 3_600_000);
    ok(
      await e.instructor.client.put(
        `${base(e, item.id)}/extensions/${await participantOf(owner, e.offeringId, d.userId)}`,
        { extendedDueAt: dExt.toISOString() },
      ),
    );

    const out = await scan(now);
    expect(out.assignmentReminders).toBe(1);
    expect(await notificationsOf(owner, a.userId, 'due_soon')).toEqual([]);
    expect(await notificationsOf(owner, c.userId, 'due_soon')).toEqual([]);
    expect(await notificationsOf(owner, d.userId, 'due_soon')).toEqual([]);
    const nb = await notificationsOf(owner, b.userId, 'due_soon');
    expect(nb).toHaveLength(1);
    expect(nb[0]).toMatchObject({
      category: 'learning_deadlines',
      params: { item: 'Lab report', hours: 1 },
      link: `/offerings/${e.offeringId}/items/${item.id}/assignment`,
    });
    const [row] = await outboxOf(owner, { userId: b.userId, template: 'due_reminder' });
    expect(row?.status).toBe('queued');
    expect(row?.expires_at?.getTime()).toBe(due.getTime());

    // the same instant again: nothing new
    expect((await scan(now)).assignmentReminders ?? 0).toBe(0);
    expect(await notificationsOf(owner, b.userId, 'due_soon')).toHaveLength(1);

    // d's own threshold comes later
    const later = new Date(dExt.getTime() - 59 * 60_000);
    expect((await scan(later)).assignmentReminders).toBe(1);
    expect(await notificationsOf(owner, d.userId, 'due_soon')).toHaveLength(1);
    expect(await notificationsOf(owner, b.userId, 'due_soon')).toHaveLength(1);

    // the email: the due date in the college's zone, the link, nothing about anybody else
    await deliverEmails(t);
    const mail = t.mailer.sent.find(
      (m) => m.to === b.email && m.subject === 'Due in 1 hour: Lab report',
    );
    expect(mail?.text).toContain('You have not handed anything in yet.');
    expect(mail?.text).toContain('GMT+5:30'); // the college's zone
    expect(mail?.headers['List-Unsubscribe']).toMatch(
      /^<http:\/\/.*\/api\/notifications\/unsubscribe\/one-click\?t=v2\.k0\./,
    );
    expect(mail?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('24 hours before (and not again at 1 hour if the learner handed in meanwhile)', async () => {
    const { A, admin, st, scan } = await college('ntf-24');
    const e = await exam(owner, t, A, admin, st, 2);
    const [a, b] = e.learners as [Json, Json];
    const now = new Date();
    const due = new Date(now.getTime() + 24 * 3_600_000 - 2 * 60_000);
    const item = await addAssignment(e, { title: 'Essay', settings: { dueAt: due.toISOString() } });
    await scan(now);
    for (const l of [a, b]) {
      const n = await notificationsOf(owner, l.userId, 'due_soon');
      expect(n.map((x) => x.params.hours)).toEqual([24]);
    }
    ok(await handIn(e, a, item.id));
    await scan(new Date(due.getTime() - 59 * 60_000));
    expect((await notificationsOf(owner, a.userId, 'due_soon')).map((x) => x.params.hours)).toEqual(
      [24],
    );
    expect((await notificationsOf(owner, b.userId, 'due_soon')).map((x) => x.params.hours)).toEqual(
      [24, 1],
    );
  });

  it('an unpublished assignment or a draft offering reminds nobody', async () => {
    const { A, admin, st, scan } = await college('ntf-hid');
    const e = await exam(owner, t, A, admin, st, 1);
    const now = new Date();
    await addAssignment(e, {
      title: 'Hidden',
      published: false,
      settings: { dueAt: new Date(now.getTime() + 58 * 60_000).toISOString() },
    });
    expect((await scan(now)).assignmentReminders ?? 0).toBe(0);
  });
});

describe('quizzes', () => {
  it('opening in 1 hour; closing in 1 hour only for who has not submitted; an accommodation moves the close', async () => {
    const { A, admin, st, scan } = await college('ntf-quiz');
    const e = await exam(owner, t, A, admin, st, 3);
    const [a, b, c] = e.learners as [Json, Json, Json];
    const qq = await addQuestion(e.instructor.client, e.courseId, q.tf('Is it?', true));
    const now = new Date();
    const soon = new Date(now.getTime() + 58 * 60_000);
    const opening = await addAssessment(e, {
      title: 'Opens soon',
      settings: {
        opensAt: soon.toISOString(),
        closesAt: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
      },
      slots: [fixed(qq.id)],
    });
    const closing = await addAssessment(e, {
      title: 'Closes soon',
      settings: { closesAt: soon.toISOString() },
      slots: [fixed(qq.id)],
    });
    const at = await startAttempt(e, a, closing.id);
    ok(await submit(e, a, at.attemptId));
    ok(
      await e.instructor.client.put(
        `/offerings/${e.offeringId}/items/${closing.id}/assessment/accommodations/${await participantOf(owner, e.offeringId, c.userId)}`,
        { extraMinutes: 0, extendedCloseAt: new Date(now.getTime() + 6 * 3_600_000).toISOString() },
      ),
    );
    await scan(now);
    for (const l of [a, b, c]) {
      expect(
        (await notificationsOf(owner, l.userId, 'quiz_opens')).map((n) => n.params.item),
      ).toEqual(['Opens soon']);
    }
    expect(await notificationsOf(owner, a.userId, 'quiz_closes')).toEqual([]);
    expect(
      (await notificationsOf(owner, b.userId, 'quiz_closes')).map((n) => n.params.item),
    ).toEqual(['Closes soon']);
    expect(await notificationsOf(owner, c.userId, 'quiz_closes')).toEqual([]);
    expect(opening.id).toBeTruthy();
  });

  it('results that become visible when the quiz closes are announced by the scan after the close', async () => {
    const { A, admin, st, scan } = await college('ntf-res');
    const e = await exam(owner, t, A, admin, st, 1);
    const [a] = e.learners as [Json];
    const qq = await addQuestion(e.instructor.client, e.courseId, q.tf('Yes?', true));
    const now = new Date();
    const close = new Date(now.getTime() + 10 * 60_000);
    const quiz = await addAssessment(e, {
      title: 'After close',
      settings: { closesAt: close.toISOString(), resultsVisibility: 'after_close' },
      slots: [fixed(qq.id)],
    });
    const at = await startAttempt(e, a, quiz.id);
    ok(await submit(e, a, at.attemptId));
    await scan(now);
    expect(await notificationsOf(owner, a.userId, 'grade_released')).toEqual([]);
    await scan(new Date(close.getTime() + 60_000));
    const n = await notificationsOf(owner, a.userId, 'grade_released');
    expect(n).toHaveLength(1);
    expect(n[0]?.link).toBe(`/offerings/${e.offeringId}/attempts/${at.attemptId}/result`);
  });
});

describe('quiet hours (college zone, email only; security mail exempt)', () => {
  it('the release instant wraps midnight and follows DST', async () => {
    const rel = async (start: string, end: string, tz: string, at: string) =>
      new Date(
        (
          await owner.query(
            `SELECT lms.notify_quiet_release($1::jsonb, $2, $3::timestamptz) AS r`,
            [JSON.stringify({ quietHours: { enabled: true, start, end } }), tz, at],
          )
        ).rows[0].r,
      ).toISOString();
    // 22:30 IST -> 07:00 IST the next day
    expect(await rel('22:00', '07:00', 'Asia/Kolkata', '2026-11-16T17:00:00Z')).toBe(
      '2026-11-17T01:30:00.000Z',
    );
    // 01:30 IST -> 07:00 IST the same day
    expect(await rel('22:00', '07:00', 'Asia/Kolkata', '2026-11-16T20:00:00Z')).toBe(
      '2026-11-17T01:30:00.000Z',
    );
    // 15:30 IST: not quiet
    expect(await rel('22:00', '07:00', 'Asia/Kolkata', '2026-11-16T10:00:00Z')).toBe(
      '2026-11-16T10:00:00.000Z',
    );
    // New York, the night the clocks go forward (8 Mar 2026): 23:00 EST -> 07:00 EDT = 11:00 UTC (not 12:00)
    expect(await rel('22:00', '07:00', 'America/New_York', '2026-03-08T04:00:00Z')).toBe(
      '2026-03-08T11:00:00.000Z',
    );
    // a window that does not wrap
    expect(await rel('13:00', '15:00', 'UTC', '2026-11-16T14:00:00Z')).toBe(
      '2026-11-16T15:00:00.000Z',
    );
    expect(await rel('13:00', '15:00', 'UTC', '2026-11-16T16:00:00Z')).toBe(
      '2026-11-16T16:00:00.000Z',
    );
  });

  it('inside quiet hours: in-app at once; a 24 h reminder waits for the end; a 1 h reminder that would arrive after the deadline is dropped; security mail goes now', async () => {
    const { A, admin, st, scan } = await college('ntf-qh');
    const tz = 'Asia/Kolkata';
    const now = new Date();
    // quiet from an hour ago until two hours from now, in the college's zone
    await setNotifySettings(owner, A.tenantId, {
      quietHours: {
        enabled: true,
        start: hhmm(new Date(now.getTime() - 3_600_000), tz),
        end: hhmm(new Date(now.getTime() + 2 * 3_600_000), tz),
      },
    });
    const e = await exam(owner, t, A, admin, st, 1);
    const [a] = e.learners as [Json];
    const soon = await addAssignment(e, {
      title: 'Soon',
      settings: { dueAt: new Date(now.getTime() + 58 * 60_000).toISOString() },
    });
    const tomorrow = await addAssignment(e, {
      title: 'Tomorrow',
      settings: { dueAt: new Date(now.getTime() + 24 * 3_600_000 - 120_000).toISOString() },
    });
    await scan(now);
    expect(await notificationsOf(owner, a.userId, 'due_soon')).toHaveLength(2);
    const rows = await outboxOf(owner, { userId: a.userId, template: 'due_reminder' });
    const byItem = (title: string) => rows.find((r) => r.params.item === title);
    expect(byItem('Soon')).toMatchObject({
      status: 'expired',
      skip_reason: 'quiet_hours_past_deadline',
    });
    const waiting = byItem('Tomorrow');
    expect(waiting?.status).toBe('queued');
    expect(hhmm(waiting?.run_after as Date, tz)).toBe(
      hhmm(new Date(now.getTime() + 2 * 3_600_000), tz),
    );
    // nothing is delivered before the end of quiet hours
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === a.email && m.subject.startsWith('Due in'))).toEqual(
      [],
    );
    // security mail is exempt
    await new TestClient(t, A.host).post('/auth/password/forgot', { email: a.email });
    await deliverEmails(t);
    expect(t.mailer.sent.some((m) => m.to === a.email && m.subject === 'Reset your password')).toBe(
      true,
    );
    expect(soon.id && tomorrow.id).toBeTruthy();
  });

  it('a queued email whose send time falls into quiet hours (a retry, a late job) is deferred, not sent', async () => {
    const { A, admin, st, scan } = await college('ntf-def');
    const e = await exam(owner, t, A, admin, st, 1);
    const [a] = e.learners as [Json];
    const now = new Date();
    await addAssignment(e, {
      title: 'Deferred',
      settings: { dueAt: new Date(now.getTime() + 24 * 3_600_000 - 120_000).toISOString() },
    });
    await scan(now);
    const tz = 'Asia/Kolkata';
    await setNotifySettings(owner, A.tenantId, {
      quietHours: {
        enabled: true,
        start: hhmm(new Date(now.getTime() - 3_600_000), tz),
        end: hhmm(new Date(now.getTime() + 3_600_000), tz),
      },
    });
    await deliverEmails(t);
    expect(t.mailer.sent.filter((m) => m.to === a.email && m.subject.startsWith('Due in'))).toEqual(
      [],
    );
    const [row] = await outboxOf(owner, { userId: a.userId, template: 'due_reminder' });
    expect(row?.status).toBe('queued');
    const { rows: jobs } = await owner.query(
      `SELECT status, run_at, singleton_key FROM lms.jobs WHERE payload ->> 'outboxId' = $1 ORDER BY created_at`,
      [row?.id],
    );
    expect(jobs.map((j) => j.status)).toEqual(['completed', 'queued']);
    expect(new Date(jobs[1].run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });
});

describe('daily digests in the college time zone', () => {
  it('new content: ONE digest per course per local day, from the digest hour; hidden items are skipped', async () => {
    const { A, admin, st, scan } = await college('ntf-dig');
    const tz = 'America/New_York';
    await owner.query(
      `INSERT INTO lms.tenant_settings (id, tenant_id, key, value) VALUES (lms.uuid_v7(), $1, 'timezone', to_jsonb($2::text))
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [A.tenantId, tz],
    );
    const e = await exam(owner, t, A, admin, st, 2);
    const [a] = e.learners as [Json];
    for (const title of ['Slides 1', 'Notes <2>', 'Gone']) {
      ok(
        await e.instructor.client.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
          kind: 'link',
          title,
          url: 'https://example.com/x',
          published: true,
        }),
      );
    }
    const gone = (
      await owner.query(
        `SELECT id FROM lms.content_items WHERE offering_id = $1 AND title = 'Gone'`,
        [e.offeringId],
      )
    ).rows[0].id;
    ok(
      await e.instructor.client.patch(`/offerings/${e.offeringId}/items/${gone}`, {
        published: false,
      }),
    );

    const now = new Date();
    const before = await localInstant(now, 1, '06:30', tz);
    const after = await localInstant(now, 1, '07:05', tz);
    expect((await scan(before)).contentDigests ?? 0).toBe(0);
    const out = await scan(after);
    expect(out.contentDigests).toBe(2); // two learners, one course
    const n = await notificationsOf(owner, a.userId, 'content_digest');
    expect(n).toHaveLength(1);
    expect(n[0]?.params).toMatchObject({ count: 2, titles: ['Slides 1', 'Notes <2>'] });
    expect(n[0]?.link).toBe(`/offerings/${e.offeringId}`);
    // the same local day again: nothing
    expect((await scan(new Date(after.getTime() + 3_600_000))).contentDigests ?? 0).toBe(0);
    await deliverEmails(t);
    const mail = t.mailer.sent.find((m) => m.to === a.email && m.subject.startsWith('New in'));
    expect(mail?.subject).toMatch(/: 2 items$/);
    expect(mail?.html).toContain('Notes &lt;2&gt;');
    // REGRESSION (found by the benchmark): the outbox key is per event AND RECIPIENT. A digest has ONE event key for the whole
    // course, so a key without the recipient queued a single email for 60 learners.
    for (const l of e.learners) {
      expect(
        t.mailer.sent.filter((m) => m.to === l.email && m.subject.startsWith('New in')),
        l.email,
      ).toHaveLength(1);
    }
    expect(
      await outboxOf(owner, { template: 'content_digest', tenantId: A.tenantId }),
    ).toHaveLength(2);
  });

  it('work waiting to be graded: one digest per instructor / assistant (counts), nothing to learners', async () => {
    const { A, admin, st, scan } = await college('ntf-grd');
    const e = await exam(owner, t, A, admin, st, 2);
    const [a] = e.learners as [Json];
    const item = await addAssignment(e, { title: 'Waiting', settings: { dueAt: inHours(48) } });
    ok(await handIn(e, a, item.id));
    const at = await localInstant(new Date(), 1, '08:00', 'Asia/Kolkata');
    expect((await scan(at)).gradingDigests).toBe(2);
    for (const p of [e.instructor, e.assistant]) {
      const n = await notificationsOf(owner, p.userId, 'grading_digest');
      expect(n).toHaveLength(1);
      expect(n[0]?.params).toMatchObject({ total: 1 });
      expect(n[0]?.category).toBe('teaching_grading');
    }
    expect(await notificationsOf(owner, a.userId, 'grading_digest')).toEqual([]);
  });
});

describe('weekly summaries (Mondays)', () => {
  it('at-risk: counts per course to instructors and assistants (no names); course health: a count to the admins', async () => {
    const { A, admin, st, scan } = await college('ntf-wk');
    const e = await exam(owner, t, A, admin, st, 2);
    for (const title of ['Missed 1', 'Missed 2']) {
      const it2 = await addAssignment(e, { title, settings: { dueAt: inHours(1) } });
      await setDates(owner, it2.id, {
        opensAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
    }
    // a running offering with no content at all: "needs attention"
    const { newCourse, newOffering } = await import('./courses-helpers');
    const c2 = await newCourse(admin);
    const o2 = await newOffering(admin, c2.id, st.termId);
    const inst2 = (await import('./courses-helpers')).person;
    const p2 = await inst2(owner, t, A, 'Teacher2');
    ok(
      await admin.post(`/offerings/${o2.id}/participants`, {
        userId: p2.userId,
        participation: 'instructor',
      }),
    );
    ok(await p2.client.post(`/offerings/${o2.id}/publish`));

    await t.app.modules.analytics.service.refreshTenant(A.tenantId);
    // the next Monday, 08:00 in the college's zone
    const { rows } = await owner.query(
      `SELECT ((date_trunc('week', (now() AT TIME ZONE 'Asia/Kolkata')) + interval '7 days 8 hours') AT TIME ZONE 'Asia/Kolkata') AS at`,
    );
    const monday = new Date(rows[0].at);
    const out = await scan(monday);
    expect(out.atRiskSummaries).toBe(2);
    for (const p of [e.instructor, e.assistant]) {
      const n = await notificationsOf(owner, p.userId, 'atrisk_weekly');
      expect(n).toHaveLength(1);
      expect(n[0]?.params.total).toBe(2);
      const text = JSON.stringify(n[0]?.params);
      for (const l of e.learners) expect(text).not.toContain(l.email);
    }
    const h = await notificationsOf(owner, A.adminUserId, 'course_health_weekly');
    expect(h).toHaveLength(1);
    expect(Number(h[0]?.params.count)).toBeGreaterThanOrEqual(1);
    // the same Monday again: nothing
    const again = await scan(new Date(monday.getTime() + 3_600_000));
    expect(again.atRiskSummaries ?? 0).toBe(0);
    // a Tuesday: no weekly run
    const tue = await scan(new Date(monday.getTime() + 86_400_000));
    expect(tue.atRiskSummaries ?? 0).toBe(0);
  });
});

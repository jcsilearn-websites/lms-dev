import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { addAssessment, addQuestion, fixed, q, startAttempt, submit } from './assessments-helpers';
import {
  addAssignment,
  base,
  exam,
  handIn,
  inHours,
  keyFromDb,
  queue,
} from './assignments-helpers';
import { deliverEmails } from './client';
import { type Json, loginAs, ok, person, type Structure, structure } from './courses-helpers';
import {
  mailTo,
  notificationsOf,
  outboxOf,
  participantOf,
  quietOff,
} from './notifications-helpers';
import { type AuthFixture, createAuthFixture, createPlatformAdmin, testOwnerPool } from './support';

// Step 13: where notifications come from (triggers in the SAME transaction as the change). Every event lands as an in-app
// row and an outbox row (+ its email.send job), for the right people only, once, and carries no mark, no feedback, no reason.
// The last test is the privacy sentinel over EVERYTHING this file produced.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: Awaited<ReturnType<typeof loginAs>>;
let st: Structure;

// planted secrets: none of these may appear in any notification, outbox row or email
const SECRET = {
  score: '73.25',
  feedback: 'FEEDBACK-SENTINEL-91f3',
  extension: 'EXTREASON-SENTINEL-77aa',
  accommodation: 'ACCREASON-SENTINEL-5c2e',
  override: 'OVERRIDE-SENTINEL-c0de',
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'ntf-e');
  await t.app.ready();
  await quietOff(owner, A.tenantId);
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const feedbackDoc = (text: string): Json => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('assignment grades', () => {
  it('a release notifies exactly the released learners, once, with a link and without the mark or the feedback', async () => {
    const e = await exam(owner, t, A, admin, st, 3);
    const item = await addAssignment(e, { title: 'Essay one', settings: { dueAt: inHours(48) } });
    const [a, b, c] = e.learners as [Json, Json, Json];
    for (const l of [a, b, c]) ok(await handIn(e, l, item.id));
    await queue(e, e.instructor, item.id);
    const keys: string[] = [];
    for (const l of [a, b, c]) {
      const { key } = await keyFromDb(owner, item.id, l);
      keys.push(key);
      const sid = ok(await e.instructor.client.get(`${base(e, item.id)}/grading/learners/${key}`))
        .submissions[0].id;
      ok(
        await e.instructor.client.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
          submissionId: sid,
          rawScore: Number(SECRET.score),
          feedback: feedbackDoc(SECRET.feedback),
        }),
      );
    }
    // graded but not released: nothing yet
    expect(await notificationsOf(owner, a.userId, 'grade_released')).toEqual([]);

    ok(await e.instructor.client.post(`${base(e, item.id)}/release`, { learnerKeys: [keys[0]] }));
    const na = await notificationsOf(owner, a.userId, 'grade_released');
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({
      category: 'learning_grades',
      link: `/offerings/${e.offeringId}/items/${item.id}/assignment`,
      params: { item: 'Essay one', kind: 'assignment', hasFeedback: true },
    });
    expect(await notificationsOf(owner, b.userId, 'grade_released')).toEqual([]);

    // releasing everybody: b and c now; a is NOT notified again
    ok(await e.instructor.client.post(`${base(e, item.id)}/release`, {}));
    expect(await notificationsOf(owner, a.userId, 'grade_released')).toHaveLength(1);
    expect(await notificationsOf(owner, b.userId, 'grade_released')).toHaveLength(1);
    expect(await notificationsOf(owner, c.userId, 'grade_released')).toHaveLength(1);

    const mails = await mailTo(t, a.email);
    const mail = mails.find((m) => m.subject.includes('Essay one'));
    expect(mail?.subject).toBe('Your work on Essay one has been returned');
    expect(mail?.text).toContain('Your instructor also left feedback.');
    expect(mail?.text).toContain(`/offerings/${e.offeringId}/items/${item.id}/assignment`);
    expect(mail?.text).not.toContain(SECRET.score);
    expect(mail?.html).not.toContain(SECRET.feedback);
  });

  it('release_mode immediate: saving the grade is the release (one notification per handed-in version)', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const item = await addAssignment(e, {
      title: 'Immediate',
      settings: { dueAt: inHours(48), releaseMode: 'immediate' },
    });
    const [a] = e.learners as [Json];
    ok(await handIn(e, a, item.id));
    await queue(e, e.instructor, item.id);
    const { key } = await keyFromDb(owner, item.id, a);
    const sid = ok(await e.instructor.client.get(`${base(e, item.id)}/grading/learners/${key}`))
      .submissions[0].id;
    const grade = (raw: number) =>
      e.instructor.client.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: raw,
      });
    ok(await grade(50));
    ok(await grade(60)); // a regrade of the same version: no second message
    const n = await notificationsOf(owner, a.userId, 'grade_released');
    expect(n).toHaveLength(1);
    expect(n[0]?.params).toMatchObject({ hasFeedback: false });
  });
});

describe('extensions and accommodations', () => {
  it('the learner is told something changed, never the reason; the same date twice is one message', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const item = await addAssignment(e, { title: 'Report', settings: { dueAt: inHours(10) } });
    const [a] = e.learners as [Json];
    const pid = await participantOf(owner, e.offeringId, a.userId);
    const due = inHours(30);
    for (let i = 0; i < 2; i++) {
      ok(
        await e.instructor.client.put(`${base(e, item.id)}/extensions/${pid}`, {
          extendedDueAt: due,
          reason: SECRET.extension,
        }),
      );
    }
    const n = await notificationsOf(owner, a.userId, 'extension_granted');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ category: 'learning_deadlines', params: { item: 'Report' } });
    const mail = (await mailTo(t, a.email)).find((m) => m.subject.includes('Report'));
    expect(mail?.subject).toBe('Your deadline for Report was changed');
  });

  it('an accommodation says "your arrangements were updated" and nothing else', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const qq = await addQuestion(e.instructor.client, e.courseId, q.tf('Sky is blue', true));
    const item = await addAssessment(e, { title: 'Midterm', slots: [fixed(qq.id)] });
    const [a] = e.learners as [Json];
    const pid = await participantOf(owner, e.offeringId, a.userId);
    ok(
      await e.instructor.client.put(
        `/offerings/${e.offeringId}/items/${item.id}/assessment/accommodations/${pid}`,
        { extraMinutes: 25, reason: SECRET.accommodation },
      ),
    );
    const n = await notificationsOf(owner, a.userId, 'accommodation_updated');
    expect(n).toHaveLength(1);
    // (not a bare '25': a random id or a unique course title can contain it)
    expect(JSON.stringify(n[0]?.params)).not.toMatch(/minutes|extra/i);
    const mail = (await mailTo(t, a.email)).find((m) => m.subject.includes('Midterm'));
    expect(mail?.subject).toBe('Your arrangements for Midterm were updated');
    expect(mail?.text).not.toMatch(/25 min|minutes|extra time/i);
  });
});

describe('quiz results', () => {
  it('manual release notifies the learner once per attempt; an auto-graded immediate quiz does not', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const qq = await addQuestion(e.instructor.client, e.courseId, q.tf('Water is wet', true));
    const manual = await addAssessment(e, {
      title: 'Manual quiz',
      settings: { resultsVisibility: 'manual' },
      slots: [fixed(qq.id)],
    });
    const instant = await addAssessment(e, { title: 'Instant quiz', slots: [fixed(qq.id)] });
    const [a, b] = e.learners as [Json, Json];
    for (const l of [a, b]) {
      const at = await startAttempt(e, l, manual.id);
      ok(await submit(e, l, at.attemptId));
    }
    const ai = await startAttempt(e, a, instant.id);
    ok(await submit(e, a, ai.attemptId));
    expect(await notificationsOf(owner, a.userId, 'grade_released')).toEqual([]);

    ok(
      await e.instructor.client.post(
        `/offerings/${e.offeringId}/items/${manual.id}/assessment/release`,
        {},
      ),
    );
    for (const l of [a, b]) {
      const n = await notificationsOf(owner, l.userId, 'grade_released');
      expect(n).toHaveLength(1);
      expect(n[0]?.params).toMatchObject({ item: 'Manual quiz', kind: 'assessment' });
      expect(n[0]?.link).toMatch(
        new RegExp(`^/offerings/${e.offeringId}/attempts/[0-9a-f-]+/result$`),
      );
    }
    const mail = (await mailTo(t, a.email)).find((m) => m.subject.includes('Manual quiz'));
    expect(mail?.subject).toBe('Your result for Manual quiz is ready');
  });
});

describe('teaching and admin events (written by the workflow functions and the worker)', () => {
  it('gradebook submitted -> the college admins; approved / returned -> the instructors (never the actor, never the comment)', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    // every offering has its gradebook row (created with it)
    const gb = (
      await owner.query(
        `INSERT INTO lms.gradebooks (id, tenant_id, offering_id) VALUES (lms.uuid_v7(), $1, $2)
         ON CONFLICT (tenant_id, offering_id) DO UPDATE SET updated_at = now() RETURNING id`,
        [A.tenantId, e.offeringId],
      )
    ).rows[0].id;
    const event = (action: string, actor: string, comment: string | null) =>
      owner.query(
        `INSERT INTO lms.gradebook_events (id, tenant_id, gradebook_id, version_no, action, actor_user_id, comment)
         VALUES (lms.uuid_v7(), $1, $2, 1, $3, $4, $5)`,
        [A.tenantId, gb, action, actor, comment],
      );
    // two more institution admins: EVERY admin gets the email (one outbox row per event and recipient)
    const extraAdmins = [
      await person(owner, t, A, 'AdminTwo', { role: 'institution_admin' }),
      await person(owner, t, A, 'AdminThree', { role: 'institution_admin' }),
    ];
    await event('submitted', e.instructor.userId, null);
    const sub = await notificationsOf(owner, A.adminUserId, 'gradebook_submitted');
    expect(sub).toHaveLength(1);
    for (const a2 of [A.adminEmail, ...extraAdmins.map((x) => x.email)]) {
      expect(
        (await mailTo(t, a2)).filter((m) =>
          m.subject.startsWith('Gradebook submitted for approval'),
        ),
        a2,
      ).toHaveLength(1);
    }
    expect(sub[0]).toMatchObject({ category: 'admin', link: '/gradebooks' });
    await event('returned', A.adminUserId, SECRET.override);
    const ret = await notificationsOf(owner, e.instructor.userId, 'gradebook_returned');
    expect(ret).toHaveLength(1);
    expect(ret[0]?.link).toBe(`/offerings/${e.offeringId}/gradebook`);
    // the assistant is not an instructor: nothing
    expect(await notificationsOf(owner, e.assistant.userId, 'gradebook_returned')).toEqual([]);
    // the actor is never told about their own action
    await event('approved', e.instructor.userId, null);
    expect(await notificationsOf(owner, e.instructor.userId, 'gradebook_approved')).toEqual([]);
  });

  it('a video that finished processing (or failed) notifies its uploader', async () => {
    const e = await exam(owner, t, A, admin, st, 0);
    const v = (
      await owner.query(
        `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status)
         VALUES (lms.uuid_v7(), $1, $2, $3, '<b>lecture</b>.mp4', 10, 'processing') RETURNING id`,
        [A.tenantId, e.offeringId, e.instructor.userId],
      )
    ).rows[0].id;
    await owner.query(
      `UPDATE lms.video_assets SET status = 'ready', duration_ms = 1000, hls_prefix = 'x', ready_at = now() WHERE id = $1`,
      [v],
    );
    await owner.query(`UPDATE lms.video_assets SET progress = 100 WHERE id = $1`, [v]);
    const n = await notificationsOf(owner, e.instructor.userId, 'video_ready');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      category: 'teaching_updates',
      link: `/offerings/${e.offeringId}/build`,
    });
    const mail = (await mailTo(t, e.instructor.email)).find((m) =>
      m.subject.startsWith('Video ready'),
    );
    // the file name is the uploader's text: escaped in HTML
    expect(mail?.html).toContain('&lt;b&gt;lecture&lt;/b&gt;.mp4');
    expect(mail?.html).not.toContain('<b>lecture</b>');
  });

  it('an import that finished notifies whoever started it', async () => {
    const imp = (
      await owner.query(
        `INSERT INTO lms.import_jobs (id, tenant_id, kind, file_name, status, created_by_user_id)
         VALUES (lms.uuid_v7(), $1, 'students', 'students.csv', 'processing', $2) RETURNING id`,
        [A.tenantId, A.adminUserId],
      )
    ).rows[0].id;
    await owner.query(
      `UPDATE lms.import_jobs SET status = 'completed_with_errors', processed_rows = 9, failed_rows = 1 WHERE id = $1`,
      [imp],
    );
    const n = await notificationsOf(owner, A.adminUserId, 'import_finished');
    expect(n.filter((x) => x.link === `/imports/${imp}`)).toHaveLength(1);
  });

  it('a closed usage month notifies every platform admin (their own inbox + email, no college)', async () => {
    const root = await createPlatformAdmin(owner, 'usage-root@ntf.test');
    await owner.query(
      `INSERT INTO lms.usage_snapshots (tenant_id, month, time_zone, billable_learners, active_users, video_seconds,
         video_gb_estimate, storage_bytes, offerings, active_offerings, definition, rendition_mix)
       VALUES ($1, '2026-01-01', 'Asia/Kolkata', 1, 1, 0, 0, 0, 0, 0, '{}', '{}')`,
      [A.tenantId],
    );
    const { rows } = await owner.query(
      `SELECT type, params, link FROM lms.platform_notifications WHERE user_id = $1`,
      [root.userId],
    );
    expect(rows).toEqual([
      { type: 'usage_closed', params: { month: '2026-01-01', colleges: 1 }, link: '/usage' },
    ]);
    const out = await outboxOf(owner, { userId: root.userId, template: 'usage_closed' });
    expect(out).toHaveLength(1);
    expect(out[0]?.tenant_id).toBeNull();
    await deliverEmails(t);
    const mail = t.mailer.sent.find((m) => m.to === root.email);
    expect(mail?.subject).toBe('Usage closed for January 2026');
    expect(mail?.text).toContain('http://admin.localhost/usage');
    expect(mail?.headers['List-Unsubscribe']).toBeUndefined();
  });
});

describe('who never gets anything', () => {
  it('a learner removed from the offering is not notified of a release', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const item = await addAssignment(e, { title: 'Late leaver', settings: { dueAt: inHours(48) } });
    const [a, b] = e.learners as [Json, Json];
    for (const l of [a, b]) ok(await handIn(e, l, item.id));
    await queue(e, e.instructor, item.id);
    for (const l of [a, b]) {
      const { key } = await keyFromDb(owner, item.id, l);
      const sid = ok(await e.instructor.client.get(`${base(e, item.id)}/grading/learners/${key}`))
        .submissions[0].id;
      ok(
        await e.instructor.client.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
          submissionId: sid,
          rawScore: 10,
        }),
      );
    }
    const pb = await participantOf(owner, e.offeringId, b.userId);
    ok(await admin.delete(`/offerings/${e.offeringId}/participants/${pb}`));
    ok(await e.instructor.client.post(`${base(e, item.id)}/release`, {}));
    expect(await notificationsOf(owner, a.userId, 'grade_released')).toHaveLength(1);
    expect(await notificationsOf(owner, b.userId, 'grade_released')).toEqual([]);
  });
});

describe('PRIVACY SENTINEL', () => {
  it('no mark, feedback text, extension / accommodation / override reason appears in any notification, outbox row or email', async () => {
    await deliverEmails(t);
    const { rows: n } = await owner.query(`SELECT params::text AS p, link FROM lms.notifications`);
    const { rows: o } = await owner.query(`SELECT params::text AS p FROM lms.email_outbox`);
    const haystacks = [
      ...n.map((r) => `${r.p} ${r.link ?? ''}`),
      ...o.map((r) => r.p),
      ...t.mailer.sent.map(
        (m) => `${m.subject}\n${m.text}\n${m.html}\n${JSON.stringify(m.headers)}`,
      ),
    ];
    expect(n.length).toBeGreaterThan(5);
    expect(t.mailer.sent.length).toBeGreaterThan(5);
    for (const h of haystacks) {
      for (const secret of Object.values(SECRET)) expect(h).not.toContain(secret);
      // no score-like fields at all in the params
      expect(h).not.toMatch(
        /"(score|rawScore|finalScore|points|percent|feedback|reason|evidence)"/,
      );
    }
  });
});

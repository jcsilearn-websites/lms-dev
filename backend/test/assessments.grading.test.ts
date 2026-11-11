// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssessment,
  addQuestion,
  type Exam,
  exam,
  fixed,
  learnerOption,
  optionId,
  posOf,
  q,
  readAttempt,
  save,
  startAttempt,
  submit,
} from './assessments-helpers';
import type { TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Step 9c: accommodations (sensitive), grading, regrade, release and what a learner may see, item analysis, and the
// "nothing leaks" sweep over every endpoint a learner can reach.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'ag-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const base = (e: Exam, itemId: string) => `/offerings/${e.offeringId}/items/${itemId}/assessment`;
const participantOf = async (e: Exam, userId: string): Promise<string> =>
  (
    await owner.query(
      `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.id = p.membership_id
        WHERE p.offering_id = $1 AND m.user_id = $2`,
      [e.offeringId, userId],
    )
  ).rows[0].id;
const attemptRow = async (id: string) =>
  (await owner.query('SELECT * FROM lms.attempts WHERE id = $1', [id])).rows[0];

/** Answers the learner's attempt with a map of stem -> answer, then submits. */
async function take(
  e: Exam,
  who: Exam['learners'][number],
  itemId: string,
  answers: Record<string, (a: Json) => Json>,
) {
  const s = await startAttempt(e, who, itemId);
  const a = await readAttempt(e, who, s.attemptId);
  const batch = Object.entries(answers).map(([stem, f], i) => ({
    position: posOf(a, stem),
    answer: f(a),
    rev: 1,
    at: i + 1,
  }));
  if (batch.length > 0) ok(await save(e, who, s.attemptId, batch));
  ok(await submit(e, who, s.attemptId));
  return s.attemptId;
}
const pick = (stem: string, label: string) => (a: Json) => ({ o: [learnerOption(a, stem, label)] });

describe('accommodations', () => {
  let e: Exam;
  let item: Json;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 3);
    const one = await addQuestion(e.instructor.client, e.courseId, q.single('Acc?', ['a', 'b'], 0));
    item = await addAssessment(e, {
      settings: { timeLimitMinutes: 30, closesAt: new Date(Date.now() + 3_600_000).toISOString() },
      slots: [fixed(one.id)],
    });
  });

  it('extra time lengthens the learner deadline (never past the close time); others keep the limit', async () => {
    const [l1, l2, l3] = e.learners as [
      Exam['learners'][number],
      Exam['learners'][number],
      Exam['learners'][number],
    ];
    const pid = await participantOf(e, l1.userId);
    const set = ok(
      await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
        extraMinutes: 15,
        reason: 'approved by the disability office',
      }),
    );
    expect(set).toMatchObject({
      participantId: pid,
      extraMinutes: 15,
      reason: 'approved by the disability office',
    });
    const left = async (who: Exam['learners'][number]) => {
      const s = await startAttempt(e, who, item.id);
      const a = await readAttempt(e, who, s.attemptId);
      return (
        (new Date(a.attempt.deadlineAt).getTime() - new Date(a.attempt.serverNow).getTime()) / 60000
      );
    };
    expect(await left(l1)).toBeGreaterThan(44.5);
    expect(await left(l1)).toBeLessThanOrEqual(45);
    expect(await left(l2)).toBeLessThanOrEqual(30);
    // a huge extension is cut at the close time (1 h from now), not start + limit + extra
    const pid3 = await participantOf(e, l3.userId);
    ok(
      await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid3}`, {
        extraMinutes: 600,
      }),
    );
    const l3Left = await left(l3);
    expect(l3Left).toBeGreaterThan(55);
    expect(l3Left).toBeLessThanOrEqual(60);
    // the learner sees their own extra minutes on their page
    expect(ok(await l1.client.get(`${base(e, item.id)}/me`)).assessment.extraMinutes).toBe(15);
  });

  it('an extended close date lets that learner start after everybody else is locked out', async () => {
    const one = await addQuestion(
      e.instructor.client,
      e.courseId,
      q.single('Late?', ['a', 'b'], 0),
    );
    const late = await addAssessment(e, {
      settings: { timeLimitMinutes: 20 },
      slots: [fixed(one.id)],
    });
    await owner.query(
      `UPDATE lms.assessments SET opens_at = now() - interval '3 hours', closes_at = now() - interval '1 hour' WHERE item_id = $1`,
      [late.id],
    );
    const [l1, l2] = e.learners as [Exam['learners'][number], Exam['learners'][number]];
    ok(
      await e.instructor.client.put(
        `${base(e, late.id)}/accommodations/${await participantOf(e, l1.userId)}`,
        { extraMinutes: 0, extendedCloseAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      ),
    );
    expect(
      errorCode(await l2.client.post(`/offerings/${e.offeringId}/items/${late.id}/attempts`)),
    ).toBe('assessment_closed');
    expect(
      (await l1.client.post(`/offerings/${e.offeringId}/items/${late.id}/attempts`)).statusCode,
    ).toBe(200);
    const me = ok(await l1.client.get(`${base(e, late.id)}/me`));
    expect(new Date(me.assessment.closesAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('the reason is for instructors and administrators only: not assistants, learners, lists or exports', async () => {
    const secret = 'sensitive-reason-text-9431';
    const l = e.learners[1]!;
    const pid = await participantOf(e, l.userId);
    ok(
      await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
        extraMinutes: 10,
        reason: secret,
      }),
    );
    const list = ok(await e.instructor.client.get(`${base(e, item.id)}/accommodations`));
    expect(list.items.find((x: Json) => x.participantId === pid).reason).toBe(secret);
    expect(
      ok(await admin.get(`${base(e, item.id)}/accommodations`)).items.some(
        (x: Json) => x.reason === secret,
      ),
    ).toBe(true);
    expect((await e.assistant.client.get(`${base(e, item.id)}/accommodations`)).statusCode).toBe(
      403,
    );
    expect((await l.client.get(`${base(e, item.id)}/accommodations`)).statusCode).toBe(403);
    expect(
      (
        await e.assistant.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
          extraMinutes: 99,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await admin.put(`${base(e, item.id)}/accommodations/${pid}`, { extraMinutes: 99 }))
        .statusCode,
    ).toBe(403);
    // not in what a learner, an assistant or a class list gets
    const s = await startAttempt(e, l, item.id);
    const bodies = [
      (await l.client.get(`${base(e, item.id)}/me`)).body,
      (await l.client.get(`/offerings/${e.offeringId}/attempts/${s.attemptId}`)).body,
      (await e.assistant.client.get(`${base(e, item.id)}/attempts`)).body,
      (await e.assistant.client.get(`/offerings/${e.offeringId}/progress/class`)).body,
      (await e.assistant.client.get(`/offerings/${e.offeringId}/progress/class.csv`)).body,
      (await e.instructor.client.get(`${base(e, item.id)}/attempts`)).body,
      (await e.instructor.client.get(`/offerings/${e.offeringId}/progress/class.csv`)).body,
      (await e.instructor.client.get(`/offerings/${e.offeringId}/participants`)).body,
      (await e.instructor.client.get(`/offerings/${e.offeringId}/attempts/${s.attemptId}/grading`))
        .body,
    ];
    for (const b of bodies) expect(b).not.toContain(secret);
  });

  it('is audited with who changed what (minutes, dates) but NEVER the reason text', async () => {
    const secret = 'audit-must-not-see-this-7788';
    const l = e.learners[2]!;
    const pid = await participantOf(e, l.userId);
    ok(
      await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
        extraMinutes: 20,
        reason: secret,
      }),
    );
    ok(
      await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
        extraMinutes: 25,
        reason: `${secret} again`,
      }),
    );
    ok(await e.instructor.client.delete(`${base(e, item.id)}/accommodations/${pid}`));
    const rows = (
      await owner.query(
        `SELECT action, actor_user_id, metadata FROM lms.audit_log WHERE tenant_id = $1 AND action LIKE 'assessment.accommodation%' AND metadata ->> 'participantId' = $2 ORDER BY created_at, id`,
        [A.tenantId, pid],
      )
    ).rows;
    const mine = rows.slice(-3); // this learner also had one set by an earlier test
    expect(mine.map((r) => r.action)).toEqual([
      'assessment.accommodation_set',
      'assessment.accommodation_set',
      'assessment.accommodation_removed',
    ]);
    expect(mine.every((r) => r.actor_user_id === e.instructor.userId)).toBe(true);
    expect(mine[0].metadata.after).toMatchObject({ extraMinutes: 20 });
    expect(mine[1].metadata.before).toMatchObject({ extraMinutes: 20 });
    expect(mine[1].metadata.after).toMatchObject({ extraMinutes: 25 });
    expect(JSON.stringify(rows)).not.toContain(secret);
    const everything = await owner.query(
      `SELECT count(*)::int AS n FROM lms.audit_log WHERE metadata::text LIKE $1 OR action LIKE $1`,
      [`%${secret}%`],
    );
    expect(everything.rows[0].n).toBe(0);
    const viaApi = await admin.get('/audit', { query: 'limit=100' });
    expect(viaApi.body).not.toContain(secret);
  });

  it('cannot be set for someone who is not a learner of the offering', async () => {
    const pid = await participantOf(e, e.assistant.userId);
    expect(
      errorCode(
        await e.instructor.client.put(`${base(e, item.id)}/accommodations/${pid}`, {
          extraMinutes: 5,
        }),
      ),
    ).toBe('participant_not_found');
  });
});

describe('grading', () => {
  let e: Exam;
  let essay: Json;
  let item: Json;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 3);
    const c = e.instructor.client;
    essay = await addQuestion(c, e.courseId, q.essay('Describe osmosis.'));
    const mc = await addQuestion(c, e.courseId, q.single('Auto one', ['x', 'y'], 0));
    item = await addAssessment(e, { slots: [fixed(mc.id, 1), fixed(essay.id, 10)] });
    for (const [i, l] of e.learners.entries())
      await take(e, l, item.id, {
        'Auto one': pick('Auto one', 'x'),
        'Describe osmosis.': () => ({ t: `Essay of learner ${i + 1}` }),
      });
  });

  it('lists the questions that wait, and the answers of one question for grading across students', async () => {
    const sum = ok(await e.assistant.client.get(`${base(e, item.id)}/grading/summary`));
    expect(sum.attemptsToGrade).toBe(3);
    expect(sum.questions).toHaveLength(1);
    expect(sum.questions[0]).toMatchObject({
      questionId: essay.id,
      type: 'essay',
      pending: 3,
      graded: 0,
      points: 10,
    });
    const answers = ok(
      await e.assistant.client.get(`${base(e, item.id)}/grading/answers`, {
        query: `questionId=${essay.id}&limit=2`,
      }),
    );
    expect(answers.items).toHaveLength(2);
    expect(answers.nextCursor).not.toBeNull();
    expect(answers.items[0].answer.t).toMatch(/^Essay of learner/);
    const rest = ok(
      await e.assistant.client.get(`${base(e, item.id)}/grading/answers`, {
        query: `questionId=${essay.id}&after=${answers.nextCursor}`,
      }),
    );
    expect(rest.items).toHaveLength(1);
    const byStudent = ok(
      await e.assistant.client.get(`${base(e, item.id)}/attempts`, { query: 'status=submitted' }),
    );
    expect(byStudent.items).toHaveLength(3);
    expect(byStudent.items[0]).toMatchObject({ pendingManual: 1, score: 1, maxScore: 11 });
  });

  it('assistants grade; the mark is validated; the attempt becomes graded when nothing waits', async () => {
    const attempts = ok(await e.instructor.client.get(`${base(e, item.id)}/attempts`))
      .items as Json[];
    const [a1, a2, a3] = attempts as [Json, Json, Json];
    const gradeUrl = (id: string) => `/offerings/${e.offeringId}/attempts/${id}/questions/2/grade`;
    // position of the essay in each attempt (no shuffle: 2)
    expect((await e.assistant.client.put(gradeUrl(a1.attemptId), { score: 11 })).statusCode).toBe(
      400,
    );
    expect((await e.assistant.client.put(gradeUrl(a1.attemptId), { score: -1 })).statusCode).toBe(
      400,
    );
    const g = ok(
      await e.assistant.client.put(gradeUrl(a1.attemptId), {
        score: 7.5,
        feedback: 'Good, but mention the membrane.',
      }),
    );
    expect(g).toMatchObject({
      score: 7.5,
      attemptStatus: 'graded',
      attemptScore: 8.5,
      pendingManual: 0,
    });
    expect(await attemptRow(a1.attemptId)).toMatchObject({ status: 'graded', pending_manual: 0 });
    // a second, corrected grade replaces the first
    const again = ok(await e.assistant.client.put(gradeUrl(a1.attemptId), { score: 9 }));
    expect(again.attemptScore).toBe(10);
    // the auto-graded question cannot be graded by hand
    expect(
      errorCode(
        await e.assistant.client.put(
          `/offerings/${e.offeringId}/attempts/${a2.attemptId}/questions/1/grade`,
          { score: 1 },
        ),
      ),
    ).toBe('answer_not_found');
    // learners and strangers cannot grade
    expect(
      (await e.learners[0]!.client.put(gradeUrl(a2.attemptId), { score: 10 })).statusCode,
    ).toBe(403);
    expect((await admin.put(gradeUrl(a2.attemptId), { score: 10 })).statusCode).toBe(403);
    ok(await e.instructor.client.put(gradeUrl(a2.attemptId), { score: 3 }));
    ok(await e.instructor.client.put(gradeUrl(a3.attemptId), { score: 0 }));
    const sum = ok(await e.instructor.client.get(`${base(e, item.id)}/grading/summary`));
    expect(sum.attemptsToGrade).toBe(0);
    expect(sum.questions[0]).toMatchObject({ pending: 0, graded: 3 });
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM lms.attempts WHERE assessment_item_id = $1 AND status = 'graded'`,
          [item.id],
        )
      ).rows[0].n,
    ).toBe(3);
  });

  it('shows an instructor the whole script with the key, marks, feedback and the integrity log', async () => {
    const attempts = ok(await e.instructor.client.get(`${base(e, item.id)}/attempts`))
      .items as Json[];
    const script = ok(
      await e.assistant.client.get(
        `/offerings/${e.offeringId}/attempts/${attempts[0].attemptId}/grading`,
      ),
    );
    expect(script.questions).toHaveLength(2);
    expect(script.questions[0].key.correct).toHaveLength(1);
    expect(script.attempt.learnerName).toMatch(/Learner/);
    expect(Array.isArray(script.events)).toBe(true);
    expect(
      (
        await e.learners[0]!.client.get(
          `/offerings/${e.offeringId}/attempts/${attempts[0].attemptId}/grading`,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('keeps a feedback text for the whole attempt', async () => {
    const [a] = ok(await e.instructor.client.get(`${base(e, item.id)}/attempts`)).items as Json[];
    ok(
      await e.instructor.client.put(`/offerings/${e.offeringId}/attempts/${a.attemptId}/feedback`, {
        feedback: 'Well done overall.',
      }),
    );
    expect((await attemptRow(a.attemptId)).feedback).toBe('Well done overall.');
  });
});

describe('regrade', () => {
  async function setup(learners = 3) {
    const e = await exam(owner, t, A, admin, st, learners);
    const c = e.instructor.client;
    const flawed = await addQuestion(
      c,
      e.courseId,
      q.single('Flawed key?', ['Alpha', 'Beta', 'Gamma'], 0),
    );
    const other = await addQuestion(c, e.courseId, q.single('Fine?', ['p', 'q'], 0));
    const item = await addAssessment(e, { slots: [fixed(flawed.id, 4), fixed(other.id, 1)] });
    // learner 1 picks Alpha (right in v1), 2 picks Beta, 3 leaves it blank
    const picks = ['Alpha', 'Beta', null] as const;
    const ids: string[] = [];
    for (const [i, l] of e.learners.entries()) {
      const label = picks[i];
      ids.push(
        await take(e, l, item.id, {
          'Fine?': pick('Fine?', 'p'),
          ...(label ? { 'Flawed key?': pick('Flawed key?', label) } : {}),
        }),
      );
    }
    return { e, c, flawed, item, ids };
  }

  it('re-scores with a corrected key (same options), shows before / after first, records the run and audits it', async () => {
    const { e, c, flawed, item, ids } = await setup();
    expect(Number((await attemptRow(ids[0]!)).score)).toBe(5);
    expect(Number((await attemptRow(ids[1]!)).score)).toBe(1);
    // the key was wrong: Beta is right. Same options, new correct flag = a new version with the same option ids
    const fix = q.single('Flawed key?', ['Alpha', 'Beta', 'Gamma'], 1);
    for (const [i, label] of ['Alpha', 'Beta', 'Gamma'].entries())
      fix.options[i].id = optionId(flawed, label);
    const v2 = ok(await c.put(`/courses/${e.courseId}/questions/${flawed.id}`, fix));
    const url = `${base(e, item.id)}/regrade`;
    const dry = ok(
      await c.post(url, {
        questionId: flawed.id,
        action: 'rekey',
        toVersionId: v2.versionId,
        dryRun: true,
      }),
    );
    expect(dry).toMatchObject({
      applied: false,
      runId: null,
      affectedAttempts: 3,
      changedScores: 2,
    });
    expect(dry.changes.map((x: Json) => [x.before, x.after]).sort()).toEqual(
      [
        [1, 5],
        [5, 1],
      ].sort(),
    );
    expect(Number((await attemptRow(ids[0]!)).score)).toBe(5); // a dry run writes nothing
    const run = ok(
      await c.post(url, {
        questionId: flawed.id,
        action: 'rekey',
        toVersionId: v2.versionId,
        dryRun: false,
      }),
    );
    expect(run).toMatchObject({ applied: true, affectedAttempts: 3, changedScores: 2 });
    expect(run.runId).not.toBeNull();
    expect(Number((await attemptRow(ids[0]!)).score)).toBe(1);
    expect(Number((await attemptRow(ids[1]!)).score)).toBe(5);
    expect(Number((await attemptRow(ids[2]!)).score)).toBe(1);
    // what each attempt showed is untouched; only the scoring version moved
    const aq = (
      await owner.query(
        `SELECT question_version_id, scored_version_id FROM lms.attempt_questions WHERE attempt_id = $1 AND position = 1`,
        [ids[0]],
      )
    ).rows[0];
    expect(aq.question_version_id).toBe(flawed.versionId);
    expect(aq.scored_version_id).toBe(v2.versionId);
    // history and audit
    const hist = ok(await c.get(`${base(e, item.id)}/regrades`));
    expect(hist.items).toHaveLength(1);
    expect(hist.items[0]).toMatchObject({ action: 'rekey', affectedAttempts: 3 });
    const changes = await owner.query(
      'SELECT before_score, after_score FROM lms.regrade_changes WHERE run_id = $1 ORDER BY before_score',
      [run.runId],
    );
    expect(changes.rows.map((r) => [Number(r.before_score), Number(r.after_score)]).sort()).toEqual(
      [
        [1, 1],
        [1, 5],
        [5, 1],
      ],
    );
    const audit = await owner.query(
      `SELECT metadata FROM lms.audit_log WHERE action = 'assessment.regrade' AND target_id = $1`,
      [item.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ action: 'rekey', affectedAttempts: 3 });
    // running it again changes nothing (every attempt already scores with that version)
    const again = ok(
      await c.post(url, {
        questionId: flawed.id,
        action: 'rekey',
        toVersionId: v2.versionId,
        dryRun: false,
      }),
    );
    expect(again).toMatchObject({ applied: false, affectedAttempts: 0 });
  });

  it('refuses a rekey when the options changed (a different question), and unknown versions', async () => {
    const { e, c, flawed, item } = await setup(1);
    const bigger = q.single('Flawed key?', ['Alpha', 'Beta', 'Gamma', 'Delta'], 1);
    for (const [i, label] of ['Alpha', 'Beta', 'Gamma'].entries())
      bigger.options[i].id = optionId(flawed, label);
    const v2 = ok(await c.put(`/courses/${e.courseId}/questions/${flawed.id}`, bigger));
    const url = `${base(e, item.id)}/regrade`;
    expect(
      errorCode(
        await c.post(url, {
          questionId: flawed.id,
          action: 'rekey',
          toVersionId: v2.versionId,
          dryRun: false,
        }),
      ),
    ).toBe('options_changed');
    expect(
      errorCode(await c.post(url, { questionId: flawed.id, action: 'rekey', dryRun: true })),
    ).toBe('invalid_version');
    expect(
      errorCode(
        await c.post(url, {
          questionId: flawed.id,
          action: 'rekey',
          toVersionId: '0194c000-0000-7000-8000-000000000000',
          dryRun: true,
        }),
      ),
    ).toBe('invalid_version');
  });

  it('drop: the question stops counting in score and maximum; credit: everybody gets the points', async () => {
    const { e, c, flawed, item, ids } = await setup();
    const url = `${base(e, item.id)}/regrade`;
    const drop = ok(await c.post(url, { questionId: flawed.id, action: 'drop', dryRun: false }));
    expect(drop).toMatchObject({ applied: true, affectedAttempts: 3 });
    for (const id of ids)
      expect(await attemptRow(id)).toMatchObject({ score: '1.00', max_score: '1.00' });
    const credit = ok(
      await c.post(url, { questionId: flawed.id, action: 'credit', dryRun: false }),
    );
    expect(credit.applied).toBe(true);
    for (const id of ids)
      expect(await attemptRow(id)).toMatchObject({ score: '5.00', max_score: '5.00' });
    expect(
      ok(await c.get(`${base(e, item.id)}/regrades`)).items.map((x: Json) => x.action),
    ).toEqual(['credit', 'drop']);
  });

  it('is for instructors only; an assistant cannot regrade, a learner cannot see it', async () => {
    const { e, flawed, item } = await setup(1);
    const body = { questionId: flawed.id, action: 'drop', dryRun: true };
    expect((await e.assistant.client.post(`${base(e, item.id)}/regrade`, body)).statusCode).toBe(
      403,
    );
    expect((await e.learners[0]!.client.post(`${base(e, item.id)}/regrade`, body)).statusCode).toBe(
      403,
    );
    expect((await admin.post(`${base(e, item.id)}/regrade`, body)).statusCode).toBe(403);
  });

  it('re-scoring keeps a mark a person gave and reopens nothing it should not', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    const essay = await addQuestion(c, e.courseId, q.essay('Write.'));
    const item = await addAssessment(e, { slots: [fixed(essay.id, 10)] });
    const id = await take(e, e.learners[0]!, item.id, { 'Write.': () => ({ t: 'words' }) });
    ok(
      await e.instructor.client.put(`/offerings/${e.offeringId}/attempts/${id}/questions/1/grade`, {
        score: 6,
      }),
    );
    const v2 = ok(
      await c.put(`/courses/${e.courseId}/questions/${essay.id}`, q.essay('Write (reworded).')),
    );
    const r = ok(
      await c.post(`${base(e, item.id)}/regrade`, {
        questionId: essay.id,
        action: 'rekey',
        toVersionId: v2.versionId,
        dryRun: false,
      }),
    );
    expect(r.changedScores).toBe(0);
    expect(await attemptRow(id)).toMatchObject({ score: '6.00', status: 'graded' });
  });
});

describe('release and what a learner may see', () => {
  async function setup(settings: Json) {
    const e = await exam(owner, t, A, admin, st, 2);
    const c = e.instructor.client;
    const mc = await addQuestion(
      c,
      e.courseId,
      q.single('Seen?', ['yes', 'no'], 0, {
        explanation: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Because of reasons.' }] },
          ],
        },
      }),
    );
    const essay = await addQuestion(c, e.courseId, q.essay('Say more.'));
    const item = await addAssessment(e, { settings, slots: [fixed(mc.id, 2), fixed(essay.id, 3)] });
    const ids = [];
    for (const l of e.learners)
      ids.push(
        await take(e, l, item.id, {
          'Seen?': pick('Seen?', 'yes'),
          'Say more.': () => ({ t: 'more' }),
        }),
      );
    const grade = (id: string, score: number) =>
      c.put(`/offerings/${e.offeringId}/attempts/${id}/questions/2/grade`, {
        score,
        feedback: 'ok',
      });
    return { e, c, item, ids, grade, mc };
  }
  const result = (e: Exam, l: Exam['learners'][number], id: string) =>
    l.client.get(`/offerings/${e.offeringId}/attempts/${id}/result`);

  it('manual release: nothing until the instructor releases; only graded attempts are released', async () => {
    const { e, c, item, ids, grade } = await setup({
      resultsVisibility: 'manual',
      answersVisibility: 'after_release',
    });
    const [l1, l2] = e.learners as [Exam['learners'][number], Exam['learners'][number]];
    // submitted, waiting for the essay grade: no score for anyone
    expect(ok(await result(e, l1, ids[0]!)).result).toBe('not_released');
    ok(await grade(ids[0]!, 3));
    // graded but not released: still hidden, and the page says nothing about a score
    const hidden = ok(await result(e, l1, ids[0]!));
    expect(hidden).toMatchObject({ result: 'not_released', questions: [] });
    const me = ok(await l1.client.get(`${base(e, item.id)}/me`));
    expect(me.attempts[0]).toMatchObject({ resultsVisible: false, score: null });
    expect(me.counted).toBeNull();
    // release: learner 1 (graded) is released, learner 2 (still waiting for a grade) is not
    const rel = ok(await c.post(`${base(e, item.id)}/release`, {}));
    expect(rel).toEqual({ released: 1, stillPending: 1 });
    const shown = ok(await result(e, l1, ids[0]!));
    expect(shown.result).toBe('ok');
    expect(shown.attempt).toMatchObject({
      score: 5,
      maxScore: 5,
      percent: 100,
      answersShown: true,
    });
    expect(shown.questions[0].key.correct).toHaveLength(1);
    expect(JSON.stringify(shown.questions[0].key.explanation)).toContain('Because of reasons.');
    expect(shown.questions[1]).toMatchObject({ score: 3, feedback: 'ok' });
    expect(ok(await result(e, l2, ids[1]!)).result).toBe('not_released');
    // releasing again releases nothing; once learner 2 is graded a second release picks them up
    expect(ok(await c.post(`${base(e, item.id)}/release`, {})).released).toBe(0);
    ok(await grade(ids[1]!, 1));
    expect(ok(await c.post(`${base(e, item.id)}/release`, { attemptIds: [ids[1]!] }))).toEqual({
      released: 1,
      stillPending: 0,
    });
    expect(ok(await result(e, l2, ids[1]!)).attempt.score).toBe(3);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM lms.audit_log WHERE action = 'assessment.release' AND target_id = $1`,
          [item.id],
        )
      ).rows[0].n,
    ).toBe(2);
    // learners cannot release; assistants cannot either
    expect((await l1.client.post(`${base(e, item.id)}/release`, {})).statusCode).toBe(403);
    expect((await e.assistant.client.post(`${base(e, item.id)}/release`, {})).statusCode).toBe(403);
  });

  it('immediate results with answers never shown: the score yes, the key no', async () => {
    const { e, item, ids, grade } = await setup({
      resultsVisibility: 'immediate',
      answersVisibility: 'never',
    });
    const l1 = e.learners[0]!;
    ok(await grade(ids[0]!, 3));
    const r = ok(await result(e, l1, ids[0]!));
    expect(r.attempt).toMatchObject({ score: 5, answersShown: false });
    expect(r.questions).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain('"key"');
    expect(JSON.stringify(r)).not.toContain('Because of reasons.');
    // an attempt still waiting for grading shows no score yet, only the per-question marks that exist
    const waiting = ok(await result(e, e.learners[1]!, ids[1]!));
    expect(waiting.attempt).toMatchObject({ pendingGrading: true, score: null });
    const me = ok(await l1.client.get(`${base(e, item.id)}/me`));
    expect(me.counted).toMatchObject({ score: 5, maxScore: 5, percent: 100 });
  });

  it('after close: hidden until the close date has passed (and the accommodations with it)', async () => {
    const { e, c, item, ids, grade } = await setup({
      resultsVisibility: 'after_close',
      answersVisibility: 'after_close',
      closesAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    ok(await grade(ids[0]!, 3));
    const l1 = e.learners[0]!;
    expect(ok(await result(e, l1, ids[0]!)).result).toBe('not_released');
    // a learner with an extended close date is still working: results stay hidden until THEIR close has passed too
    ok(
      await c.put(
        `${base(e, item.id)}/accommodations/${await participantOf(e, e.learners[1]!.userId)}`,
        { extraMinutes: 0, extendedCloseAt: new Date(Date.now() + 5 * 3_600_000).toISOString() },
      ),
    );
    await owner.query(
      `UPDATE lms.assessments SET opens_at = now() - interval '3 hours', closes_at = now() - interval '1 hour' WHERE item_id = $1`,
      [item.id],
    );
    expect(ok(await result(e, l1, ids[0]!)).result).toBe('not_released');
    await owner.query(
      `UPDATE lms.assessment_accommodations SET extended_close_at = now() - interval '5 minutes' WHERE assessment_item_id = $1`,
      [item.id],
    );
    const open = ok(await result(e, l1, ids[0]!));
    expect(open.result).toBe('ok');
    expect(open.attempt.answersShown).toBe(true);
  });

  it('an attempt in progress has no result; someone else cannot read mine', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const mc = await addQuestion(e.instructor.client, e.courseId, q.single('Live?', ['a', 'b'], 0));
    const item = await addAssessment(e, { slots: [fixed(mc.id)] });
    const s = await startAttempt(e, e.learners[0]!, item.id);
    expect(errorCode(await result(e, e.learners[0]!, s.attemptId))).toBe('attempt_in_progress');
    expect((await result(e, e.learners[1]!, s.attemptId)).statusCode).toBe(404);
  });
});

describe('item analysis', () => {
  it('reports percent correct, the option distribution, average score and time', async () => {
    const e = await exam(owner, t, A, admin, st, 4);
    const c = e.instructor.client;
    const hard = await addQuestion(
      c,
      e.courseId,
      q.single('Hard one', ['right', 'wrong1', 'wrong2'], 0),
    );
    const easy = await addQuestion(c, e.courseId, q.single('Easy one', ['yes', 'no'], 0));
    const item = await addAssessment(e, { slots: [fixed(hard.id, 2), fixed(easy.id, 2)] });
    const picks = [
      ['right', 'yes'],
      ['wrong1', 'yes'],
      ['wrong1', 'yes'],
      ['wrong2', 'no'],
    ] as const;
    for (const [i, l] of e.learners.entries())
      await take(e, l, item.id, {
        'Hard one': pick('Hard one', picks[i]![0]),
        'Easy one': pick('Easy one', picks[i]![1]),
      });
    const an = ok(await c.get(`${base(e, item.id)}/analysis`));
    expect(an.attempts).toBe(4);
    expect(an.averagePercent).toBe(50);
    const h = an.questions.find((x: Json) => x.questionId === hard.id);
    expect(h).toMatchObject({ answered: 4, total: 4, correctPercent: 25, averagePercent: 25 });
    expect(h.options.map((o: Json) => [o.picked, o.correct]).sort()).toEqual(
      [
        [1, false],
        [1, true],
        [2, false],
      ].sort(),
    );
    const ez = an.questions.find((x: Json) => x.questionId === easy.id);
    expect(ez.correctPercent).toBe(75);
    expect(ez.options.find((o: Json) => o.correct).picked).toBe(3);
    expect((await e.assistant.client.get(`${base(e, item.id)}/analysis`)).statusCode).toBe(403);
    expect((await e.learners[0]!.client.get(`${base(e, item.id)}/analysis`)).statusCode).toBe(403);
  });
});

describe('no answer leaks to a learner before results are released (every endpoint, every state)', () => {
  it('sweeps all learner-reachable endpoints with sentinels in every key', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const c = e.instructor.client;
    const SECRET = ['424242.5', 'zzsentinelzz', 'EXPLAINSENTINEL'];
    const doc = (s: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
    });
    const single = await addQuestion(
      c,
      e.courseId,
      q.single('Leak single', ['one', 'two', 'three'], 1, { explanation: doc(SECRET[2]!) }),
    );
    const num = await addQuestion(
      c,
      e.courseId,
      q.numeric('Leak numeric', 424242.5, 0.5, { explanation: doc(SECRET[2]!) }),
    );
    const short = await addQuestion(
      c,
      e.courseId,
      q.short('Leak short', [SECRET[1]!], { explanation: doc(SECRET[2]!) }),
    );
    const multi = await addQuestion(
      c,
      e.courseId,
      q.multi('Leak multi', ['m1', 'm2', 'm3'], [0, 2], { partialCredit: true }),
    );
    const item = await addAssessment(e, {
      settings: { resultsVisibility: 'manual', answersVisibility: 'after_release' },
      slots: [fixed(single.id), fixed(num.id), fixed(short.id), fixed(multi.id)],
    });
    const l = e.learners[0]!;
    const bodies: string[] = [];
    const get = async (url: string) => {
      const r = await l.client.get(url);
      bodies.push(r.body);
      return r;
    };
    const o = `/offerings/${e.offeringId}`;

    bodies.push((await l.client.get(`${o}/items/${item.id}/assessment/me`)).body);
    const s = await startAttempt(e, l, item.id);
    bodies.push(JSON.stringify(s));
    const a = await readAttempt(e, l, s.attemptId);
    bodies.push(JSON.stringify(a));
    // saves, including a stale response (which echoes the server's stored answer)
    const p = posOf(a, 'Leak numeric');
    bodies.push(
      (await save(e, l, s.attemptId, [{ position: p, answer: { n: 1 }, rev: 3, at: 5 }])).body,
    );
    bodies.push(
      (await save(e, l, s.attemptId, [{ position: p, answer: { n: 2 }, rev: 1, at: 1 }])).body,
    );
    await get(`${o}/attempts/${s.attemptId}`);
    await get(`${o}/attempts/${s.attemptId}/result`);
    bodies.push((await submit(e, l, s.attemptId)).body);
    await get(`${o}/attempts/${s.attemptId}`);
    await get(`${o}/attempts/${s.attemptId}/result`);
    await get(`${o}/items/${item.id}/assessment/me`);
    // the learner outline / item / progress endpoints that list the assessment item
    await get(`${o}/outline`);
    await get(`${o}/items/${item.id}`);
    await get(`${o}/progress`);
    await get('/me/progress');
    for (const b of bodies) {
      for (const secret of SECRET) expect(b, `leaked ${secret}`).not.toContain(secret);
      for (const field of [
        '"correct"',
        '"answerKey"',
        '"answer_key"',
        '"accepted"',
        '"tolerance"',
        '"explanation"',
        '"key"',
        '"partial"',
      ]) {
        expect(b, `field ${field}`).not.toContain(field);
      }
    }
    // after the release the same learner DOES get the key (so the check above is not vacuous)
    await owner.query(`UPDATE lms.attempts SET released_at = now() WHERE id = $1`, [s.attemptId]);
    const shown = await l.client.get(`${o}/attempts/${s.attemptId}/result`);
    expect(shown.body).toContain(SECRET[2]);
    expect(shown.body).toContain(SECRET[1]);

    // and instructor-only endpoints refuse a learner outright
    for (const url of [
      `${o}/items/${item.id}/assessment`,
      `${o}/items/${item.id}/assessment/preview`,
      `${o}/items/${item.id}/assessment/attempts`,
      `${o}/items/${item.id}/assessment/grading/summary`,
      `${o}/items/${item.id}/assessment/analysis`,
      `${o}/items/${item.id}/assessment/accommodations`,
      `${o}/items/${item.id}/assessment/regrades`,
      `${o}/attempts/${s.attemptId}/grading`,
      `/courses/${e.courseId}/questions`,
      `/courses/${e.courseId}/questions/${single.id}`,
    ]) {
      const r = await l.client.get(url);
      expect([403, 404], `${url} -> ${r.statusCode}`).toContain(r.statusCode);
    }
  });
});

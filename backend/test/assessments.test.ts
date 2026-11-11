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
  pool,
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

// Step 9b: the attempt engine, server-authoritative. Start (frozen paper, server deadline), autosave with revisions
// (older edits never win, also across devices and tabs), submit (idempotent, set-based scoring), deadlines and the
// grace, the auto-submit sweeper, accommodations, attempts allowed, pools, versions.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'as-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const cfg = (e: Exam, itemId: string) => `/offerings/${e.offeringId}/items/${itemId}/assessment`;
const text = (a: Json) => a.content[0].content[0].text as string;

/** Moves the deadline of an attempt (the clock cannot be moved, the stored deadline can). */
async function deadlineIn(attemptId: string, seconds: number) {
  await owner.query(
    `UPDATE lms.attempts SET deadline_at = now() + make_interval(secs => $2) WHERE id = $1`,
    [attemptId, seconds],
  );
}
const attemptRow = async (attemptId: string) =>
  (await owner.query('SELECT * FROM lms.attempts WHERE id = $1', [attemptId])).rows[0];

/** A quiz of fixed questions: two single choice (2 points each), a numeric and a short answer. */
async function quiz(e: Exam, settings: Json = {}) {
  const c = e.instructor.client;
  const capital = await addQuestion(
    c,
    e.courseId,
    q.single('Capital of France?', ['Paris', 'Rome', 'Oslo'], 0),
  );
  const planet = await addQuestion(
    c,
    e.courseId,
    q.multi('Gas giants?', ['Jupiter', 'Mars', 'Saturn'], [0, 2], { partialCredit: true }),
  );
  const pi = await addQuestion(c, e.courseId, q.numeric('Pi to 2 places', 3.14, 0.01));
  const au = await addQuestion(c, e.courseId, q.short('Symbol of gold', ['Au']));
  const item = await addAssessment(e, {
    settings,
    slots: [fixed(capital.id, 2), fixed(planet.id, 4), fixed(pi.id, 1), fixed(au.id, 1)],
  });
  return { item, capital, planet, pi, au };
}

describe('the builder', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 1);
  });

  it('creates an assessment item with defaults, changes settings and questions', async () => {
    const c = e.instructor.client;
    const item = ok(
      await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'assessment',
        title: 'Midterm',
        published: true,
      }),
    );
    expect(item.kind).toBe('assessment');
    expect(item.completion).toBe('on_submit');
    const fresh = ok(await c.get(cfg(e, item.id)));
    expect(fresh.settings).toMatchObject({
      kind: 'practice',
      attemptsAllowed: 1,
      scoring: 'highest',
      resultsVisibility: 'immediate',
      answersVisibility: 'never',
      timeLimitMinutes: null,
    });
    expect(fresh.slots).toEqual([]);

    const settings = ok(
      await c.put(cfg(e, item.id), {
        kind: 'exam',
        timeLimitMinutes: 45,
        attemptsAllowed: 2,
        scoring: 'average',
        passingScore: 40,
        shuffleQuestions: true,
        shuffleOptions: true,
        resultsVisibility: 'manual',
        answersVisibility: 'after_release',
      }),
    );
    expect(settings).toMatchObject({
      kind: 'exam',
      timeLimitMinutes: 45,
      attemptsAllowed: 2,
      scoring: 'average',
      passingScore: 40,
    });

    const one = await addQuestion(
      c,
      e.courseId,
      q.single('Q1', ['a', 'b'], 0, { tags: ['topic'], difficulty: 'easy' }),
    );
    ok(
      await c.put(`${cfg(e, item.id)}/slots`, {
        slots: [fixed(one.id, 3), pool({ tag: 'topic', difficulty: 'easy', count: 1, points: 2 })],
      }),
    );
    const done = ok(await c.get(cfg(e, item.id)));
    expect(done.slots).toHaveLength(2);
    expect(done.slots[0]).toMatchObject({
      kind: 'fixed',
      points: 3,
      question: { type: 'single_choice', status: 'active' },
    });
    expect(done.slots[1]).toMatchObject({
      kind: 'pool',
      tag: 'topic',
      difficulty: 'easy',
      count: 1,
      available: 1,
    });
    expect(done.totalPoints).toBe(5);
    expect(done.questionCount).toBe(2);
    // replacing with fewer slots removes the rest
    ok(await c.put(`${cfg(e, item.id)}/slots`, { slots: [fixed(one.id, 1)] }));
    expect(ok(await c.get(cfg(e, item.id))).slots).toHaveLength(1);
  });

  it('refuses bad settings and bad slots with a clear error', async () => {
    const c = e.instructor.client;
    const item = ok(
      await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'assessment',
        title: 'Bad',
        published: true,
      }),
    );
    const put = (b: Json) => c.put(cfg(e, item.id), b);
    expect(
      errorCode(await put({ opensAt: '2030-01-02T00:00:00Z', closesAt: '2030-01-01T00:00:00Z' })),
    ).toBe('invalid_settings');
    expect(errorCode(await put({ resultsVisibility: 'after_close' }))).toBe('invalid_settings');
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ attemptsAllowed: 0 })).statusCode).toBe(400);
    const slots = (s: Json[]) => c.put(`${cfg(e, item.id)}/slots`, { slots: s });
    expect(errorCode(await slots([{ kind: 'fixed', points: 1 }]))).toBe('invalid_slots');
    expect(
      errorCode(await slots([pool({ count: 100 }), pool({ count: 100 }), pool({ count: 1 })])),
    ).toBe('invalid_slots');
    // a question of ANOTHER course cannot be used
    const other = await exam(owner, t, A, admin, st, 0);
    const foreign = await addQuestion(
      other.instructor.client,
      other.courseId,
      q.single('Foreign', ['a', 'b'], 0),
    );
    expect(errorCode(await slots([fixed(foreign.id)]))).toBe('invalid_slots');
  });

  it('only instructors build; assistants, learners and administrators cannot', async () => {
    const item = (await quiz(e)).item;
    expect((await e.assistant.client.get(cfg(e, item.id))).statusCode).toBe(403);
    expect((await e.learners[0]!.client.get(cfg(e, item.id))).statusCode).toBe(403);
    expect((await admin.put(cfg(e, item.id), { attemptsAllowed: 3 })).statusCode).toBe(403);
    expect(
      (await e.assistant.client.put(`${cfg(e, item.id)}/slots`, { slots: [] })).statusCode,
    ).toBe(403);
  });

  it('previews one sample paper without answers and stores nothing', async () => {
    const { item } = await quiz(e);
    const before = (await owner.query('SELECT count(*)::int AS n FROM lms.attempts')).rows[0].n;
    const p = ok(await e.instructor.client.get(`${cfg(e, item.id)}/preview`));
    expect(p.questions).toHaveLength(4);
    expect(JSON.stringify(p)).not.toContain('correct');
    expect((await owner.query('SELECT count(*)::int AS n FROM lms.attempts')).rows[0].n).toBe(
      before,
    );
  });
});

describe('start and read: the paper is frozen and has no answers in it', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 3);
  });

  it('starts an attempt with a server deadline, and sends no key, no correctness, opaque option ids', async () => {
    const { item, capital } = await quiz(e, { timeLimitMinutes: 30 });
    const learner = e.learners[0]!;
    const started = await startAttempt(e, learner, item.id);
    expect(started.resumed).toBe(false);
    const a = await readAttempt(e, learner, started.attemptId);
    expect(a.attempt.status).toBe('in_progress');
    const left =
      (new Date(a.attempt.deadlineAt).getTime() - new Date(a.attempt.serverNow).getTime()) / 60000;
    expect(left).toBeGreaterThan(29.5);
    expect(left).toBeLessThanOrEqual(30);
    expect(a.questions).toHaveLength(4);
    for (const question of a.questions) {
      expect(Object.keys(question).sort()).toEqual([
        'answer',
        'flagged',
        'images',
        'maxWords',
        'options',
        'points',
        'position',
        'rev',
        'stem',
        'type',
      ]);
      for (const o of question.options) expect(Object.keys(o).sort()).toEqual(['id', 'text']);
    }
    // the option ids are the random ids of the version, not 'a'/'b'/'0'/'1'
    expect(a.questions[0].options.every((o: Json) => /^[0-9a-f]{12}$/.test(o.id))).toBe(true);
    const raw = JSON.stringify(a);
    expect(raw).not.toContain('"correct"');
    expect(raw).not.toContain('answerKey');
    expect(raw).not.toContain('accepted');
    // the instructor's id of the correct option never appears next to a correctness flag
    expect(optionId(capital, 'Paris')).toBe(learnerOption(a, 'Capital of France?', 'Paris'));
  });

  it('a second start (a reload, another tab or device) gets the SAME attempt; concurrent starts make one', async () => {
    const { item } = await quiz(e);
    const learner = e.learners[1]!;
    const [x, y, z] = await Promise.all([
      startAttempt(e, learner, item.id),
      startAttempt(e, learner, item.id),
      startAttempt(e, learner, item.id),
    ]);
    expect(new Set([x.attemptId, y.attemptId, z.attemptId]).size).toBe(1);
    expect([x, y, z].filter((s) => !s.resumed).length).toBe(1);
    const again = await startAttempt(e, learner, item.id);
    expect(again).toEqual({ attemptId: x.attemptId, resumed: true });
    const n = await owner.query(
      `SELECT count(*)::int AS n FROM lms.attempts WHERE assessment_item_id = $1 AND status = 'in_progress'`,
      [item.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('refuses instructors, strangers and unpublished assessments', async () => {
    const { item } = await quiz(e);
    expect(
      (await e.instructor.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`))
        .statusCode,
    ).toBe(403);
    expect(
      (await e.assistant.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`))
        .statusCode,
    ).toBe(403);
    expect(
      (await admin.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`)).statusCode,
    ).toBe(404);
    ok(
      await e.instructor.client.patch(`/offerings/${e.offeringId}/items/${item.id}`, {
        published: false,
      }),
    );
    const hidden = await e.learners[2]!.client.post(
      `/offerings/${e.offeringId}/items/${item.id}/attempts`,
    );
    expect(hidden.statusCode).toBe(404);
    expect(errorCode(hidden)).toBe('assessment_not_found');
  });

  it('refuses an assessment without questions, one not open yet and one that is closed', async () => {
    const c = e.instructor.client;
    const empty = ok(
      await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'assessment',
        title: 'Empty',
        published: true,
      }),
    );
    expect(
      errorCode(
        await e.learners[0]!.client.post(`/offerings/${e.offeringId}/items/${empty.id}/attempts`),
      ),
    ).toBe('assessment_empty');
    const { item } = await quiz(e, { opensAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(
      errorCode(
        await e.learners[0]!.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`),
      ),
    ).toBe('assessment_not_open');
    const { item: closed } = await quiz(e);
    await owner.query(
      `UPDATE lms.assessments SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE item_id = $1`,
      [closed.id],
    );
    expect(
      errorCode(
        await e.learners[0]!.client.post(`/offerings/${e.offeringId}/items/${closed.id}/attempts`),
      ),
    ).toBe('assessment_closed');
  });

  it('with no time limit and no close date an attempt still ends (24 hours at most)', async () => {
    const { item } = await quiz(e);
    const s = await startAttempt(e, e.learners[2]!, item.id);
    const row = await attemptRow(s.attemptId);
    const hours =
      (new Date(row.deadline_at).getTime() - new Date(row.started_at).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it('the deadline is the earlier of start + limit and the close time', async () => {
    const { item } = await quiz(e, {
      timeLimitMinutes: 120,
      closesAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const s = await startAttempt(e, e.learners[2]!, item.id);
    const a = await readAttempt(e, e.learners[2]!, s.attemptId);
    const left =
      (new Date(a.attempt.deadlineAt).getTime() - new Date(a.attempt.serverNow).getTime()) / 60000;
    expect(left).toBeLessThanOrEqual(10);
    expect(left).toBeGreaterThan(9);
  });

  it('shuffles questions and options per learner, and freezes the order', async () => {
    const c = e.instructor.client;
    const qs = [];
    for (let i = 0; i < 12; i++)
      qs.push(await addQuestion(c, e.courseId, q.single(`Shuffle ${i}`, ['a', 'b', 'c', 'd'], 0)));
    const item = await addAssessment(e, {
      settings: { shuffleQuestions: true, shuffleOptions: true },
      slots: qs.map((x) => fixed(x.id)),
    });
    const papers: string[] = [];
    for (const l of e.learners) {
      const s = await startAttempt(e, l, item.id);
      const a = await readAttempt(e, l, s.attemptId);
      papers.push(
        a.questions
          .map((x: Json) => text(x.stem) + x.options.map((o: Json) => text(o.text)).join(''))
          .join('|'),
      );
      // reading again gives exactly the same order
      const again = await readAttempt(e, l, s.attemptId);
      expect(again.questions.map((x: Json) => x.position)).toEqual(
        a.questions.map((x: Json) => x.position),
      );
      expect(JSON.stringify(again.questions)).toBe(JSON.stringify(a.questions));
    }
    expect(new Set(papers).size).toBe(papers.length);
  });
});

describe('pools: different papers, the same mix', () => {
  it('draws the asked number per difficulty, different per learner, and refuses a pool that is too small', async () => {
    const e = await exam(owner, t, A, admin, st, 4);
    const c = e.instructor.client;
    for (let i = 0; i < 6; i++)
      await addQuestion(
        c,
        e.courseId,
        q.single(`Easy ${i}`, ['a', 'b'], 0, { difficulty: 'easy', tags: ['pool'] }),
      );
    for (let i = 0; i < 6; i++)
      await addQuestion(
        c,
        e.courseId,
        q.single(`Hard ${i}`, ['a', 'b'], 0, { difficulty: 'hard', tags: ['pool'] }),
      );
    await addQuestion(
      c,
      e.courseId,
      q.single('Other tag', ['a', 'b'], 0, { difficulty: 'easy', tags: ['elsewhere'] }),
    );
    const item = await addAssessment(e, {
      slots: [
        pool({ tag: 'pool', difficulty: 'easy', count: 3 }),
        pool({ tag: 'pool', difficulty: 'hard', count: 2, points: 5 }),
      ],
    });
    const papers = new Set<string>();
    for (const l of e.learners) {
      const s = await startAttempt(e, l, item.id);
      const a = await readAttempt(e, l, s.attemptId);
      const stems = a.questions.map((x: Json) => text(x.stem) as string);
      expect(stems.filter((x: string) => x.startsWith('Easy'))).toHaveLength(3);
      expect(stems.filter((x: string) => x.startsWith('Hard'))).toHaveLength(2);
      expect(stems).not.toContain('Other tag');
      expect(new Set(stems).size).toBe(5);
      expect(a.questions.filter((x: Json) => x.points === 5)).toHaveLength(2);
      papers.add([...stems].sort().join());
    }
    // 4 learners drawing 3 of 6 and 2 of 6: all four identical papers is a 1 in 1,500^3 chance
    expect(papers.size).toBeGreaterThan(1);

    const tooBig = await addAssessment(e, {
      slots: [pool({ tag: 'pool', difficulty: 'easy', count: 7 })],
    });
    expect(
      errorCode(
        await e.learners[0]!.client.post(`/offerings/${e.offeringId}/items/${tooBig.id}/attempts`),
      ),
    ).toBe('pool_too_small');
    expect(errorCode(await c.get(`${cfg(e, tooBig.id)}/preview`))).toBe('pool_too_small');
    const attempts = await owner.query(
      'SELECT count(*)::int AS n FROM lms.attempts WHERE assessment_item_id = $1',
      [tooBig.id],
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  it('a question both fixed and in a pool appears once; archived questions leave the pool', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    const only = await addQuestion(
      c,
      e.courseId,
      q.single('Only one', ['a', 'b'], 0, { tags: ['solo'] }),
    );
    const gone = await addQuestion(
      c,
      e.courseId,
      q.single('Archived', ['a', 'b'], 0, { tags: ['solo'] }),
    );
    ok(await c.post(`/courses/${e.courseId}/questions/${gone.id}/archive`));
    const item = await addAssessment(e, {
      slots: [fixed(only.id), pool({ tag: 'solo', count: 1 })],
    });
    // the pool's only candidate is the fixed question (the archived one does not count): too small, not a duplicate
    expect(
      errorCode(
        await e.learners[0]!.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`),
      ),
    ).toBe('pool_too_small');
  });
});

describe('autosave and revisions', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 2);
  });

  it('saves answers and flags, returns them on read with their revisions', async () => {
    const { item } = await quiz(e);
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    const p1 = posOf(a, 'Capital of France?');
    const r = ok(
      await save(e, l, s.attemptId, [
        {
          position: p1,
          answer: { o: [learnerOption(a, 'Capital of France?', 'Paris')] },
          rev: 1,
          flagged: true,
          at: Date.now(),
        },
      ]),
    );
    expect(r).toMatchObject({ result: 'ok', applied: 1, stale: [] });
    expect(new Date(r.deadlineAt).getTime()).toBeGreaterThan(Date.now());
    const back = await readAttempt(e, l, s.attemptId);
    const x = back.questions.find((qq: Json) => qq.position === p1);
    expect(x).toMatchObject({ rev: 1, flagged: true });
    expect(x.answer.o).toHaveLength(1);
    // clearing an answer
    ok(await save(e, l, s.attemptId, [{ position: p1, answer: null, rev: 2, at: Date.now() }]));
    expect(
      (await readAttempt(e, l, s.attemptId)).questions.find((qq: Json) => qq.position === p1),
    ).toMatchObject({ rev: 2, answer: null, flagged: false });
  });

  it('an older revision never overwrites a newer one; the stale answer comes back so the client adopts it', async () => {
    const { item } = await quiz(e);
    const l = e.learners[1]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    const p = posOf(a, 'Pi to 2 places');
    ok(await save(e, l, s.attemptId, [{ position: p, answer: { n: 3 }, rev: 5, at: 1000 }]));
    const late = ok(
      await save(e, l, s.attemptId, [{ position: p, answer: { n: 99 }, rev: 4, at: 2000 }]),
    );
    expect(late.applied).toBe(0);
    expect(late.stale).toEqual([{ position: p, rev: 5, answer: { n: 3 }, flagged: false }]);
    const same = ok(
      await save(e, l, s.attemptId, [{ position: p, answer: { n: 3 }, rev: 5, at: 1000 }]),
    );
    expect(same.applied).toBe(0); // a retried request changes nothing
    expect(
      (await readAttempt(e, l, s.attemptId)).questions.find((qq: Json) => qq.position === p).answer,
    ).toEqual({ n: 3 });
  });

  it('device A answers, device B resumes at the server revision and its change wins', async () => {
    const { item } = await quiz(e);
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    const p = posOf(a, 'Symbol of gold');
    // device A: three edits
    for (const [i, v] of ['A', 'Au', 'Ag'].entries())
      ok(
        await save(e, l, s.attemptId, [
          { position: p, answer: { t: v }, rev: i + 1, at: 1000 + i },
        ]),
      );
    // device B reads, continues from the SERVER rev (3), and changes the answer
    const onB = await readAttempt(e, l, s.attemptId);
    const seen = onB.questions.find((qq: Json) => qq.position === p);
    expect(seen).toMatchObject({ rev: 3, answer: { t: 'Ag' } });
    ok(
      await save(e, l, s.attemptId, [
        { position: p, answer: { t: 'Au' }, rev: seen.rev + 1, at: 5000 },
      ]),
    );
    // device A, still believing rev 3, edits with rev 4 too: the tie goes to the later client time only if it IS later
    const lateA = ok(
      await save(e, l, s.attemptId, [{ position: p, answer: { t: 'old A' }, rev: 4, at: 4000 }]),
    );
    expect(lateA.applied).toBe(0);
    expect(
      (await readAttempt(e, l, s.attemptId)).questions.find((qq: Json) => qq.position === p).answer,
    ).toEqual({ t: 'Au' });
  });

  it('two tabs racing on one question end with the LATEST edit, whichever request lands first', async () => {
    const { item } = await quiz(e);
    const l = e.learners[1]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    const p = posOf(a, 'Symbol of gold');
    // both tabs are at rev 1 and choose rev 2; tab 2's edit is the later one (client time)
    const tab1 = save(e, l, s.attemptId, [
      { position: p, answer: { t: 'first' }, rev: 2, at: 10_000 },
    ]);
    const tab2 = save(e, l, s.attemptId, [
      { position: p, answer: { t: 'second' }, rev: 2, at: 10_500 },
    ]);
    await Promise.all([tab1, tab2]);
    expect(
      (await readAttempt(e, l, s.attemptId)).questions.find((qq: Json) => qq.position === p).answer,
    ).toEqual({ t: 'second' });
    // and in the other arrival order
    const { item: item2 } = await quiz(e);
    const s2 = await startAttempt(e, e.learners[0]!, item2.id);
    const a2 = await readAttempt(e, e.learners[0]!, s2.attemptId);
    const p2 = posOf(a2, 'Symbol of gold');
    ok(
      await save(e, e.learners[0]!, s2.attemptId, [
        { position: p2, answer: { t: 'second' }, rev: 2, at: 10_500 },
      ]),
    );
    const older = ok(
      await save(e, e.learners[0]!, s2.attemptId, [
        { position: p2, answer: { t: 'first' }, rev: 2, at: 10_000 },
      ]),
    );
    expect(older.applied).toBe(0);
    expect(
      (await readAttempt(e, e.learners[0]!, s2.attemptId)).questions.find(
        (qq: Json) => qq.position === p2,
      ).answer,
    ).toEqual({ t: 'second' });
  });

  it("someone else's attempt cannot be read or written; a batch of answers is applied in one call", async () => {
    const { item } = await quiz(e);
    const s = await startAttempt(e, e.learners[0]!, item.id);
    expect(
      (await e.learners[1]!.client.get(`/offerings/${e.offeringId}/attempts/${s.attemptId}`))
        .statusCode,
    ).toBe(404);
    expect((await save(e, e.learners[1]!, s.attemptId, [])).statusCode).toBe(404);
    expect((await submit(e, e.learners[1]!, s.attemptId)).statusCode).toBe(404);
    const a = await readAttempt(e, e.learners[0]!, s.attemptId);
    const batch = a.questions.map((x: Json, i: number) => ({
      position: x.position,
      answer: x.type === 'numeric' ? { n: 1 } : { t: 'x' },
      rev: 1,
      at: 100 + i,
    }));
    expect(ok(await save(e, e.learners[0]!, s.attemptId, batch)).applied).toBe(4);
  });

  it('logs integrity events informationally and caps them', async () => {
    const { item } = await quiz(e);
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    ok(
      await save(
        e,
        l,
        s.attemptId,
        [],
        [
          { kind: 'hidden', at: Date.now() - 5000 },
          { kind: 'visible', at: Date.now() - 1000 },
          { kind: 'offline', at: Date.now() },
        ],
      ),
    );
    const row = await attemptRow(s.attemptId);
    expect(row.event_count).toBe(3);
    const events = await owner.query(
      'SELECT kind FROM lms.attempt_events WHERE attempt_id = $1 ORDER BY n',
      [s.attemptId],
    );
    expect(events.rows.map((r) => r.kind)).toEqual(['hidden', 'visible', 'offline']);
    // an event with a made-up kind is rejected by the schema
    expect(
      (await save(e, l, s.attemptId, [], [{ kind: 'teleport' as never, at: 1 }])).statusCode,
    ).toBe(400);
  });
});

describe('submit and scoring', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 3);
  });

  it('scores every objective type at submit, incl. partial credit and tolerance, and marks the item done', async () => {
    const { item } = await quiz(e);
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    ok(
      await save(e, l, s.attemptId, [
        {
          position: posOf(a, 'Capital of France?'),
          answer: { o: [learnerOption(a, 'Capital of France?', 'Paris')] },
          rev: 1,
          at: 1,
        },
        // one of the two right options and no wrong one: half of 4 points
        {
          position: posOf(a, 'Gas giants?'),
          answer: { o: [learnerOption(a, 'Gas giants?', 'Jupiter')] },
          rev: 1,
          at: 1,
        },
        { position: posOf(a, 'Pi to 2 places'), answer: { n: 3.15 }, rev: 1, at: 1 },
        { position: posOf(a, 'Symbol of gold'), answer: { t: ' AU ' }, rev: 1, at: 1 },
      ]),
    );
    const done = ok(await submit(e, l, s.attemptId));
    expect(done.status).toBe('graded');
    const row = await attemptRow(s.attemptId);
    expect(Number(row.score)).toBe(2 + 2 + 1 + 1);
    expect(Number(row.max_score)).toBe(8);
    expect(row.submit_kind).toBe('manual');
    const p = await owner.query(
      `SELECT status, completed_how FROM lms.item_progress WHERE item_id = $1`,
      [item.id],
    );
    expect(p.rows[0]).toEqual({ status: 'completed', completed_how: 'submit' });
    // the item shows as completed in the learner's progress
    const prog = ok(await l.client.get(`/offerings/${e.offeringId}/progress`));
    expect(prog.items.find((x: Json) => x.itemId === item.id).status).toBe('completed');
  });

  it('is idempotent: a double click and two tabs give one submission and the same answer', async () => {
    const { item } = await quiz(e);
    const l = e.learners[1]!;
    const s = await startAttempt(e, l, item.id);
    const results = await Promise.all([
      submit(e, l, s.attemptId),
      submit(e, l, s.attemptId),
      submit(e, l, s.attemptId),
    ]);
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(new Set(results.map((r) => r.json().submittedAt)).size).toBe(1);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM lms.attempts WHERE assessment_item_id = $1`,
          [item.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // saving after the submit is refused politely, not as an error
    const late = ok(
      await save(e, l, s.attemptId, [{ position: 1, answer: { t: 'late' }, rev: 9, at: 9 }]),
    );
    expect(late.result).toBe('submitted');
    expect(late.applied).toBe(0);
  });

  it('a blank attempt scores zero; essays and manual short answers wait for a person', async () => {
    const c = e.instructor.client;
    const essay = await addQuestion(c, e.courseId, q.essay('Discuss the cell.'));
    const manual = await addQuestion(
      c,
      e.courseId,
      q.short('Name a river', [], { shortAnswer: { mode: 'manual' } }),
    );
    const mc = await addQuestion(c, e.courseId, q.single('Easy one', ['x', 'y'], 1));
    const item = await addAssessment(e, {
      slots: [fixed(mc.id, 1), fixed(essay.id, 10), fixed(manual.id, 2)],
    });
    const l = e.learners[2]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    ok(
      await save(e, l, s.attemptId, [
        {
          position: posOf(a, 'Easy one'),
          answer: { o: [learnerOption(a, 'Easy one', 'y')] },
          rev: 1,
          at: 1,
        },
        {
          position: posOf(a, 'Discuss the cell.'),
          answer: { t: 'The cell is the unit of life.' },
          rev: 1,
          at: 1,
        },
        { position: posOf(a, 'Name a river'), answer: { t: 'Nile' }, rev: 1, at: 1 },
      ]),
    );
    expect(ok(await submit(e, l, s.attemptId)).status).toBe('submitted');
    const row = await attemptRow(s.attemptId);
    expect(row.pending_manual).toBe(2);
    expect(Number(row.score)).toBe(1);
    // the learner is told it is waiting, with no score
    const me = ok(await l.client.get(`${cfg(e, item.id)}/me`));
    expect(me.attempts[0]).toMatchObject({
      status: 'submitted',
      pendingGrading: true,
      score: null,
    });
    expect(me.counted).toBeNull();
  });
});

describe('deadlines, the grace and auto-submit with the browser closed', () => {
  let e: Exam;
  beforeAll(async () => {
    e = await exam(owner, t, A, admin, st, 4);
  });

  it('accepts a save a few seconds after the deadline (network grace) and rejects it after the grace', async () => {
    const { item } = await quiz(e, { timeLimitMinutes: 10 });
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    const a = await readAttempt(e, l, s.attemptId);
    const p = posOf(a, 'Symbol of gold');
    await deadlineIn(s.attemptId, -10); // 10 s past the deadline, grace is 30 s
    const within = ok(
      await save(e, l, s.attemptId, [{ position: p, answer: { t: 'Au' }, rev: 1, at: 1 }]),
    );
    expect(within).toMatchObject({ result: 'ok', applied: 1 });
    await deadlineIn(s.attemptId, -60);
    const after = ok(
      await save(e, l, s.attemptId, [{ position: p, answer: { t: 'Ag' }, rev: 2, at: 2 }]),
    );
    expect(after).toMatchObject({ result: 'closed', applied: 0 });
    // the attempt was closed there and then, and scored with what was saved in time
    const row = await attemptRow(s.attemptId);
    expect(row.status).toBe('graded');
    expect(row.submit_kind).toBe('deadline');
    expect(Number(row.score)).toBe(1);
  });

  it('the sweeper submits and scores attempts nobody handed in, once, in a batch', async () => {
    const { item } = await quiz(e, { timeLimitMinutes: 10 });
    const started = [];
    for (const l of e.learners) {
      const s = await startAttempt(e, l, item.id);
      const a = await readAttempt(e, l, s.attemptId);
      ok(
        await save(e, l, s.attemptId, [
          {
            position: posOf(a, 'Capital of France?'),
            answer: { o: [learnerOption(a, 'Capital of France?', 'Paris')] },
            rev: 1,
            at: 1,
          },
        ]),
      );
      started.push(s.attemptId);
    }
    // the browsers are closed. Two attempts are past deadline + grace, two are still running
    await deadlineIn(started[0]!, -120);
    await deadlineIn(started[1]!, -120);
    await deadlineIn(started[2]!, -5);
    const closed = await t.app.modules.assessments.service.sweep();
    expect(closed).toBeGreaterThanOrEqual(2);
    for (const id of started.slice(0, 2)) {
      const row = await attemptRow(id);
      expect(row).toMatchObject({ status: 'graded', submit_kind: 'deadline' });
      expect(Number(row.score)).toBe(2);
    }
    expect((await attemptRow(started[2]!)).status).toBe('in_progress'); // inside the grace
    expect((await attemptRow(started[3]!)).status).toBe('in_progress');
    expect(await t.app.modules.assessments.service.sweep()).toBe(0); // nothing left to do: exactly once
    // progress counts the submission
    const p = await owner.query(
      `SELECT count(*)::int AS n FROM lms.item_progress WHERE item_id = $1 AND status = 'completed'`,
      [item.id],
    );
    expect(p.rows[0].n).toBe(2);
  });

  it('two sweepers at once close each attempt exactly once', async () => {
    const { item } = await quiz(e, { timeLimitMinutes: 10 });
    const ids = [];
    for (const l of e.learners) ids.push((await startAttempt(e, l, item.id)).attemptId);
    for (const id of ids) await deadlineIn(id, -120);
    const [x, y] = await Promise.all([
      t.app.modules.assessments.service.sweep(),
      t.app.modules.assessments.service.sweep(),
    ]);
    expect(x + y).toBe(4);
    const rows = await owner.query(
      `SELECT status, count(*)::int AS n FROM lms.attempts WHERE assessment_item_id = $1 GROUP BY status`,
      [item.id],
    );
    expect(rows.rows).toEqual([{ status: 'graded', n: 4 }]);
  });

  it('opening the page or the attempt after the deadline closes it too (no open attempt is ever shown)', async () => {
    const { item } = await quiz(e, { timeLimitMinutes: 10 });
    const l = e.learners[0]!;
    const s = await startAttempt(e, l, item.id);
    await deadlineIn(s.attemptId, -120);
    const a = await readAttempt(e, l, s.attemptId);
    expect(a.attempt.status).toBe('graded');
    expect(a.questions).toEqual([]);
    const { item: item2 } = await quiz(e, { timeLimitMinutes: 10 });
    const s2 = await startAttempt(e, l, item2.id);
    await deadlineIn(s2.attemptId, -120);
    const me = ok(await l.client.get(`${cfg(e, item2.id)}/me`));
    expect(me.activeAttemptId).toBeNull();
    expect(me.attempts[0].status).toBe('graded');
  });
});

describe('attempts allowed and which attempt counts', () => {
  async function takeAttempt(
    e: Exam,
    l: Exam['learners'][number],
    itemId: string,
    pick: 'right' | 'wrong',
  ) {
    const s = await startAttempt(e, l, itemId);
    const a = await readAttempt(e, l, s.attemptId);
    const label = pick === 'right' ? 'Paris' : 'Rome';
    ok(
      await save(e, l, s.attemptId, [
        {
          position: posOf(a, 'Capital?'),
          answer: { o: [learnerOption(a, 'Capital?', label)] },
          rev: 1,
          at: 1,
        },
      ]),
    );
    ok(await submit(e, l, s.attemptId));
    return s.attemptId;
  }
  async function setup(scoring: string) {
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    const one = await addQuestion(c, e.courseId, q.single('Capital?', ['Paris', 'Rome'], 0));
    const two = await addQuestion(c, e.courseId, q.single('Second?', ['x', 'y'], 0));
    const item = await addAssessment(e, {
      settings: { attemptsAllowed: 3, scoring },
      slots: [fixed(one.id, 3), fixed(two.id, 1)],
    });
    return { e, item, l: e.learners[0]! };
  }

  it.each([
    ['highest', 3],
    ['latest', 0],
    ['average', 1],
  ])('counts the %s attempt', async (scoring, expected) => {
    const { e, item, l } = await setup(scoring);
    await takeAttempt(e, l, item.id, 'wrong');
    await takeAttempt(e, l, item.id, 'right');
    await takeAttempt(e, l, item.id, 'wrong');
    const me = ok(await l.client.get(`${cfg(e, item.id)}/me`));
    expect(me.attemptsUsed).toBe(3);
    expect(me.canStart).toBe(false);
    expect(me.blockedReason).toBe('no_attempts_left');
    expect(me.counted.score).toBe(expected);
    expect(me.counted.maxScore).toBe(4);
    const fin = await t.app.modules.assessments.service.finalScores(A.tenantId, e.offeringId);
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({
      itemId: item.id,
      attemptsGraded: 3,
      score: expected,
      maxScore: 4,
      scoring,
    });
    // a fourth attempt is refused
    expect(
      errorCode(await l.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`)),
    ).toBe('no_attempts_left');
  });

  it('a new attempt starts only after the previous one is handed in', async () => {
    const { e, item, l } = await setup('highest');
    const s = await startAttempt(e, l, item.id);
    expect((await startAttempt(e, l, item.id)).attemptId).toBe(s.attemptId);
    ok(await submit(e, l, s.attemptId));
    const s2 = await startAttempt(e, l, item.id);
    expect(s2.attemptId).not.toBe(s.attemptId);
    expect(s2.resumed).toBe(false);
    const rows = await owner.query(
      'SELECT attempt_no FROM lms.attempts WHERE assessment_item_id = $1 ORDER BY attempt_no',
      [item.id],
    );
    expect(rows.rows.map((r) => r.attempt_no)).toEqual([1, 2]);
  });
});

describe('versioning: editing a question never changes what an attempt showed or how it is scored', () => {
  it('keeps the shown version and scores with it; new attempts use the new one', async () => {
    const e = await exam(owner, t, A, admin, st, 2);
    const c = e.instructor.client;
    const v1 = await addQuestion(c, e.courseId, q.single('Which is bigger?', ['Ten', 'Two'], 0));
    const item = await addAssessment(e, {
      settings: { attemptsAllowed: 2 },
      slots: [fixed(v1.id, 1)],
    });
    const [l1, l2] = e.learners as [Exam['learners'][number], Exam['learners'][number]];
    const s1 = await startAttempt(e, l1, item.id);
    const a1 = await readAttempt(e, l1, s1.attemptId);
    // the instructor now rewrites the question AND flips the key: Two is correct in version 2
    const edit = q.single('Which is smaller?', ['Ten', 'Two'], 1);
    edit.options[0].id = optionId(v1, 'Ten');
    edit.options[1].id = optionId(v1, 'Two');
    const v2 = ok(await c.put(`/courses/${e.courseId}/questions/${v1.id}`, edit));
    expect(v2.version).toBe(2);
    // the running attempt still reads version 1 ...
    expect(text((await readAttempt(e, l1, s1.attemptId)).questions[0].stem)).toBe(
      'Which is bigger?',
    );
    // ... and scores with version 1's key: "Ten" is right
    ok(
      await save(e, l1, s1.attemptId, [
        {
          position: 1,
          answer: { o: [learnerOption(a1, 'Which is bigger?', 'Ten')] },
          rev: 1,
          at: 1,
        },
      ]),
    );
    ok(await submit(e, l1, s1.attemptId));
    expect(Number((await attemptRow(s1.attemptId)).score)).toBe(1);
    // a learner who starts now gets version 2
    const s2 = await startAttempt(e, l2, item.id);
    const a2 = await readAttempt(e, l2, s2.attemptId);
    expect(text(a2.questions[0].stem)).toBe('Which is smaller?');
    ok(
      await save(e, l2, s2.attemptId, [
        {
          position: 1,
          answer: { o: [learnerOption(a2, 'Which is smaller?', 'Ten')] },
          rev: 1,
          at: 1,
        },
      ]),
    );
    ok(await submit(e, l2, s2.attemptId));
    expect(Number((await attemptRow(s2.attemptId)).score)).toBe(0);
    // the attempt row points at the version it showed
    const shown = await owner.query(
      `SELECT question_version_id FROM lms.attempt_questions WHERE attempt_id = $1`,
      [s1.attemptId],
    );
    expect(shown.rows[0].question_version_id).toBe(v1.versionId);
  });
});

describe('assessment items in the course content', () => {
  it('an assessment with attempts is archived (history stays), one without is deleted with its settings', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    const used = (await quiz(e)).item;
    const unused = (await quiz(e)).item;
    const s = await startAttempt(e, e.learners[0]!, used.id);
    ok(await submit(e, e.learners[0]!, s.attemptId));
    expect(ok(await c.delete(`/offerings/${e.offeringId}/items/${unused.id}`)).status).toBe(
      'deleted',
    );
    expect((await c.get(cfg(e, unused.id))).statusCode).toBe(404);
    expect(
      (await owner.query('SELECT 1 FROM lms.assessments WHERE item_id = $1', [unused.id])).rows,
    ).toHaveLength(0);
    expect(ok(await c.delete(`/offerings/${e.offeringId}/items/${used.id}`)).status).toBe(
      'archived',
    );
    // the attempt, its answers and its score are still there
    expect(
      (await owner.query('SELECT 1 FROM lms.attempts WHERE id = $1', [s.attemptId])).rows,
    ).toHaveLength(1);
    // archived: it left the outline of the learner
    const outline = ok(await e.learners[0]!.client.get(`/offerings/${e.offeringId}/outline`));
    expect(JSON.stringify(outline)).not.toContain(used.id);
  });

  it('an assessment item cannot get a completion rule of another kind, nor can a text item take on_submit', async () => {
    const e = await exam(owner, t, A, admin, st, 0);
    const c = e.instructor.client;
    const a = ok(
      await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'assessment',
        title: 'X',
      }),
    );
    expect(
      (await c.patch(`/offerings/${e.offeringId}/items/${a.id}`, { completion: 'manual' }))
        .statusCode,
    ).toBe(400);
    const text = ok(
      await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'text',
        title: 'T',
        body: { type: 'doc', content: [] },
      }),
    );
    expect(
      (await c.patch(`/offerings/${e.offeringId}/items/${text.id}`, { completion: 'on_submit' }))
        .statusCode,
    ).toBe(400);
    // an assessment item takes no body, file, link or video
    expect(
      (
        await c.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
          kind: 'assessment',
          title: 'Y',
          url: 'https://example.org',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('copying the content of an offering brings the assessment item with its settings and questions (Step 10)', async () => {
    const e = await exam(owner, t, A, admin, st, 1);
    const { item } = await quiz(e, { timeLimitMinutes: 20 });
    const sister = ok(
      await admin.post('/offerings', { courseId: e.courseId, termId: st.termId, label: 'copy' }),
    );
    ok(
      await admin.post(`/offerings/${sister.id}/participants`, {
        userId: e.instructor.userId,
        participation: 'instructor',
      }),
    );
    ok(
      await e.instructor.client.post(`/offerings/${sister.id}/copy`, {
        sourceOfferingId: e.offeringId,
      }),
    );
    const outline = ok(await e.instructor.client.get(`/offerings/${sister.id}/outline`));
    const copied = outline.modules
      .flatMap((m: Json) => m.items)
      .find((i: Json) => i.kind === 'assessment');
    expect(copied).toBeDefined();
    expect(copied.id).not.toBe(item.id);
    const config = ok(
      await e.instructor.client.get(`/offerings/${sister.id}/items/${copied.id}/assessment`),
    );
    expect(config.settings.timeLimitMinutes).toBe(20);
    expect(config.slots).toHaveLength(4);
    expect(config.courseId).toBe(e.courseId);
  });
});

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
  posOf,
  q,
  readAttempt,
} from './assessments-helpers';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// QUERY BUDGETS of Step 9 (see query-budget.test.ts for the rules). The exam-time calls follow the heartbeat: the session
// lookup + ONE definer call = 2. Everything else is one fused statement in a transaction: lookup + BEGIN + statement +
// COMMIT = 4.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let e: Exam;
let st: Structure;

async function measure(fn: () => Promise<unknown>): Promise<string[]> {
  t.statements.reset();
  await fn();
  await t.app.modules.background.drain();
  return t.statements.statements;
}
const run = async (
  name: string,
  fn: () => Promise<{ statusCode: number; body: string }>,
  max = 4,
) => {
  const s = await measure(async () => {
    const r = await fn();
    expect(r.statusCode, `${name}: ${r.body}`).toBeLessThan(300);
  });
  const listing = s.map((x) => x.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ');
  process.stdout.write(`ROUND-TRIPS ${name}: ${s.length} (budget ${max})\n`);
  expect(s.length, `${name} used ${s.length} round trips:\n  ${listing}`).toBeLessThanOrEqual(max);
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'qb-bud');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await exam(owner, t, A, admin, st, 3);
  await admin.get('/auth/me'); // warm the pool and the slug cache
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('round-trip budgets: question bank (step 9)', () => {
  it('every bank call is 4, the CSV import included', async () => {
    const c = e.instructor.client;
    const base = `/courses/${e.courseId}`;
    let made: Json = {};
    await run('POST /courses/:id/questions', async () => {
      const r = await c.post(
        `${base}/questions`,
        q.single('Budget?', ['a', 'b'], 0, { tags: ['bud'] }),
      );
      made = r.statusCode < 300 ? r.json() : {};
      return r;
    });
    await run('GET /courses/:id/questions', () => c.get(`${base}/questions`, { query: 'tag=bud' }));
    await run('GET /courses/:id/questions/:q', () => c.get(`${base}/questions/${made.id}`));
    await run('GET .../versions', () => c.get(`${base}/questions/${made.id}/versions`));
    await run('GET /courses/:id/question-tags', () => c.get(`${base}/question-tags`));
    await run(
      'PUT /courses/:id/questions/:q (a new version: read the kept option ids, then write, in one transaction = 5)',
      () => c.put(`${base}/questions/${made.id}`, q.single('Budget again?', ['a', 'b'], 1)),
      5,
    );
    await run('POST .../archive', () => c.post(`${base}/questions/${made.id}/archive`));
    await run('POST .../unarchive', () => c.post(`${base}/questions/${made.id}/unarchive`));
    await run('GET .../question-imports/template.csv', () =>
      c.get(`${base}/question-imports/template.csv`),
    );
    const boundary = '----bud';
    const csv =
      'type,question,option_a,option_b,correct\r\nsingle_choice,One?,a,b,A\r\nsingle_choice,Two?,a,b,B\r\n';
    let imp: Json = {};
    await run('POST .../question-imports (2 rows)', async () => {
      const r = await c.request('POST', `${base}/question-imports`, {
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
        ),
      });
      imp = r.statusCode < 300 ? r.json() : {};
      return r;
    });
    await run('GET .../question-imports/:id', () => c.get(`${base}/question-imports/${imp.id}`));
    await run('GET .../question-imports/:id/rows', () =>
      c.get(`${base}/question-imports/${imp.id}/rows`),
    );
    await run('POST .../question-imports/:id/confirm', () =>
      c.post(`${base}/question-imports/${imp.id}/confirm`, {}),
    );
  });
});

describe('round-trip budgets: assessments (step 9)', () => {
  it('builder and accommodations: 4 each', async () => {
    const c = e.instructor.client;
    const one = await addQuestion(c, e.courseId, q.single('B1', ['a', 'b'], 0));
    const item = await addAssessment(e, { slots: [fixed(one.id)] });
    const a = `/offerings/${e.offeringId}/items/${item.id}/assessment`;
    await run('GET assessment', () => c.get(a));
    await run('PUT assessment (settings)', () => c.put(a, { attemptsAllowed: 2 }));
    await run('PUT assessment/slots', () => c.put(`${a}/slots`, { slots: [fixed(one.id, 2)] }));
    await run('GET assessment/preview', () => c.get(`${a}/preview`));
    const pid = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.id = p.membership_id WHERE p.offering_id = $1 AND m.user_id = $2`,
        [e.offeringId, e.learners[0]!.userId],
      )
    ).rows[0].id;
    await run('PUT accommodations/:p', () =>
      c.put(`${a}/accommodations/${pid}`, { extraMinutes: 10, reason: 'x' }),
    );
    await run('GET accommodations', () => c.get(`${a}/accommodations`));
    await run('DELETE accommodations/:p', () => c.delete(`${a}/accommodations/${pid}`));
  });

  it('exam time (start, read, autosave, submit, my page, result) is 2; instructor reads and writes are 4', async () => {
    const c = e.instructor.client;
    const mc = await addQuestion(c, e.courseId, q.single('Budget MC', ['x', 'y'], 0));
    const essay = await addQuestion(c, e.courseId, q.essay('Budget essay'));
    const item = await addAssessment(e, { slots: [fixed(mc.id, 1), fixed(essay.id, 4)] });
    const l = e.learners[1]!;
    const base = `/offerings/${e.offeringId}`;
    const a = `${base}/items/${item.id}/assessment`;
    await run('GET assessment/me', () => l.client.get(`${a}/me`), 2);
    let attemptId = '';
    await run(
      'POST attempts (start: draws, shuffles, inserts the paper)',
      async () => {
        const r = await l.client.post(`${base}/items/${item.id}/attempts`);
        attemptId = r.statusCode < 300 ? r.json().attemptId : '';
        return r;
      },
      2,
    );
    await run(
      'POST attempts (start again: resumes)',
      () => l.client.post(`${base}/items/${item.id}/attempts`),
      2,
    );
    await run('GET attempts/:id (resume)', () => l.client.get(`${base}/attempts/${attemptId}`), 2);
    const att = await readAttempt(e, l, attemptId);
    await run(
      'PUT attempts/:id/answers (autosave of 1 answer)',
      () =>
        l.client.put(`${base}/attempts/${attemptId}/answers`, {
          answers: [
            {
              position: posOf(att, 'Budget MC'),
              answer: { o: [learnerOption(att, 'Budget MC', 'x')] },
              rev: 1,
              at: 1,
            },
          ],
          events: [],
        }),
      2,
    );
    await run(
      'PUT attempts/:id/answers (the whole paper + events)',
      () =>
        l.client.put(`${base}/attempts/${attemptId}/answers`, {
          answers: [
            { position: posOf(att, 'Budget essay'), answer: { t: 'words' }, rev: 1, at: 1 },
            { position: posOf(att, 'Budget MC'), answer: null, rev: 2, at: 2 },
          ],
          events: [{ kind: 'hidden', at: Date.now() }],
        }),
      2,
    );
    await run(
      'POST attempts/:id/submit (scores the paper)',
      () => l.client.post(`${base}/attempts/${attemptId}/submit`),
      2,
    );
    await run(
      'POST attempts/:id/submit (again)',
      () => l.client.post(`${base}/attempts/${attemptId}/submit`),
      2,
    );
    await run(
      'GET attempts/:id/result',
      () => l.client.get(`${base}/attempts/${attemptId}/result`),
      2,
    );

    // instructors and assistants
    await run('GET assessment/attempts', () => c.get(`${a}/attempts`));
    await run('GET grading/summary', () => e.assistant.client.get(`${a}/grading/summary`));
    await run('GET grading/answers', () =>
      e.assistant.client.get(`${a}/grading/answers`, { query: `questionId=${essay.id}` }),
    );
    await run('GET attempts/:id/grading (script)', () =>
      c.get(`${base}/attempts/${attemptId}/grading`),
    );
    await run('PUT attempts/:id/questions/:n/grade', () =>
      c.put(`${base}/attempts/${attemptId}/questions/${posOf(att, 'Budget essay')}/grade`, {
        score: 3,
        feedback: 'ok',
      }),
    );
    await run('PUT attempts/:id/feedback', () =>
      c.put(`${base}/attempts/${attemptId}/feedback`, { feedback: 'well done' }),
    );
    await run('POST regrade (dry run)', () =>
      c.post(`${a}/regrade`, { questionId: mc.id, action: 'credit', dryRun: true }),
    );
    await run('POST regrade (apply)', () =>
      c.post(`${a}/regrade`, { questionId: mc.id, action: 'credit', dryRun: false }),
    );
    await run('GET regrades', () => c.get(`${a}/regrades`));
    await run('POST release', () => c.post(`${a}/release`, {}));
    await run('GET analysis', () => c.get(`${a}/analysis`));
  });

  it('the worker closes a batch of attempts in 1 statement', async () => {
    const mc = await addQuestion(
      e.instructor.client,
      e.courseId,
      q.single('Sweep MC', ['x', 'y'], 0),
    );
    const item = await addAssessment(e, { slots: [fixed(mc.id)] });
    const ids: string[] = [];
    for (const l of e.learners) {
      const r = ok(await l.client.post(`/offerings/${e.offeringId}/items/${item.id}/attempts`));
      ids.push(r.attemptId);
    }
    await owner.query(
      `UPDATE lms.attempts SET deadline_at = now() - interval '5 minutes' WHERE id = ANY($1)`,
      [ids],
    );
    const s = await measure(() => t.app.modules.assessments.service.sweep());
    expect(s.length).toBe(1);
    expect(s[0]).toContain('assessment_sweep');
  });
});

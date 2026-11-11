// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import {
  addAssignment,
  base,
  classOf,
  handIn,
  inHours,
  keyFromDb,
  pdf,
  queue,
  rubricInput,
  uploadHandIn,
} from './assignments-helpers';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// QUERY BUDGETS of Step 10 (see query-budget.test.ts for the rules). Every learner call is the session lookup + ONE
// definer call = 2. Everything else is one fused statement in a transaction: lookup + BEGIN + statement + COMMIT = 4. The
// first open of the grading queue also creates the random keys (one more statement, once); the confirm of an upload reads
// the bytes between two short transactions (the documented exception of files, one more for the learner gate).

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Awaited<ReturnType<typeof classOf>>;

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
  A = await createAuthFixture(owner, 'asg-bud');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await classOf(owner, t, A, admin, st, ['Bud One', 'Bud Two', 'Bud Three']);
  await admin.get('/auth/me'); // warm the pool and the slug cache
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('round-trip budgets: assignments (step 10)', () => {
  it('rubrics: every call is 4', async () => {
    const c = e.instructor.client;
    const b = `/courses/${e.courseId}`;
    let made: Json = {};
    await run('POST /courses/:id/rubrics', async () => {
      const r = await c.post(`${b}/rubrics`, rubricInput());
      made = r.statusCode < 300 ? r.json() : {};
      return r;
    });
    await run('GET /courses/:id/rubrics', () => c.get(`${b}/rubrics`));
    await run('GET /courses/:id/rubrics/:r', () => c.get(`${b}/rubrics/${made.id}`));
    await run('PUT /courses/:id/rubrics/:r (a new version)', () =>
      c.put(`${b}/rubrics/${made.id}`, rubricInput('v2')),
    );
    await run('PATCH /courses/:id/rubrics/:r (archive)', () =>
      c.patch(`${b}/rubrics/${made.id}`, { archived: true }),
    );
  });

  it('the builder: config, settings, attachments, rubric, extensions are 4', async () => {
    const c = e.instructor.client;
    const item = await addAssignment(e, { settings: { dueAt: inHours(24) } });
    const rb = ok(await c.post(`/courses/${e.courseId}/rubrics`, rubricInput('budget')));
    const pid = (
      await owner.query(
        `SELECT p.id FROM lms.course_participants p JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
          WHERE p.offering_id = $1 AND m.user_id = $2`,
        [e.offeringId, e.learners[0]!.userId],
      )
    ).rows[0].id;
    await run('GET assignment', () => c.get(base(e, item.id)));
    await run('PUT assignment (audited)', () => c.put(base(e, item.id), { maxPoints: 60 }));
    await run('PUT attachments', () => c.put(`${base(e, item.id)}/attachments`, { fileIds: [] }));
    await run('PUT rubric', () => c.put(`${base(e, item.id)}/rubric`, { rubricId: rb.id }));
    await run('GET extensions', () => c.get(`${base(e, item.id)}/extensions`));
    await run('PUT extension (audited)', () =>
      c.put(`${base(e, item.id)}/extensions/${pid}`, { extendedDueAt: inHours(48) }),
    );
    await run('DELETE extension (audited)', () =>
      c.delete(`${base(e, item.id)}/extensions/${pid}`),
    );
  });

  it('the learner: page, upload request, hand-in are 2; the confirm of an upload is the documented exception', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(24), allowText: true } });
    const l = e.learners[0]!;
    await l.client.get('/auth/me');
    await run('GET assignment/me', () => l.client.get(`${base(e, item.id)}/me`), 2);
    let req: Json = {};
    const bytes = pdf('budget');
    await run(
      'POST assignment/files (upload request)',
      async () => {
        const r = await l.client.post(`${base(e, item.id)}/files`, {
          name: 'b.pdf',
          size: bytes.length,
        });
        req = r.statusCode < 300 ? r.json() : {};
        return r;
      },
      2,
    );
    const put = await l.client.request('PUT', req.upload.url, {
      body: bytes,
      headers: { ...req.upload.headers, 'content-length': String(bytes.length) },
    });
    expect(put.statusCode).toBe(204);
    await run(
      'POST assignment/files/:id/confirm (gate, then two short transactions around the storage read = 8)',
      () => l.client.post(`${base(e, item.id)}/files/${req.fileId}/confirm`),
      8,
    );
    await run(
      'POST assignment/submissions (the hand-in)',
      () =>
        l.client.post(`${base(e, item.id)}/submissions`, {
          requestKey: randomUUID(),
          fileIds: [req.fileId],
          text: 'x',
        }),
      2,
    );
    const mine = ok(await l.client.get(`${base(e, item.id)}/me`));
    await run(
      'GET assignment/files/:id (a download target)',
      () => l.client.get(`${base(e, item.id)}/files/${mine.submissions[0].files[0].fileId}`),
      2,
    );
  });

  it('grading: queue, summary, learner, grade, waiver, release, file are 4 (the first queue also makes the keys)', async () => {
    const c = e.instructor.client;
    const item = await addAssignment(e, { settings: { dueAt: inHours(24), maxPoints: 10 } });
    for (const l of e.learners) ok(await handIn(e, l, item.id));
    // the first open: the keys do not exist yet = one statement more, once
    await run(
      'GET grading/queue (first open: + the keys)',
      () => c.get(`${base(e, item.id)}/grading/queue`),
      6,
    );
    await run('GET grading/queue', () => c.get(`${base(e, item.id)}/grading/queue`));
    await run('GET grading/queue?status&sort&limit', () =>
      c.get(`${base(e, item.id)}/grading/queue?status=submitted&sort=time&limit=2`),
    );
    await run('GET grading/summary', () => c.get(`${base(e, item.id)}/grading/summary`));
    const { key } = await keyFromDb(owner, item.id, e.learners[0]!);
    let sid = '';
    await run('GET grading/learners/:key', async () => {
      const r = await c.get(`${base(e, item.id)}/grading/learners/${key}`);
      sid = r.statusCode < 300 ? r.json().submissions[0].id : '';
      return r;
    });
    await run('PUT grading/learners/:key/grade (rubric checked and summed in SQL, audited)', () =>
      c.put(`${base(e, item.id)}/grading/learners/${key}/grade`, {
        submissionId: sid,
        rawScore: 7,
      }),
    );
    await run('PUT penalty-waiver (audited)', () =>
      c.put(`${base(e, item.id)}/grading/learners/${key}/penalty-waiver`, {
        reason: 'portal outage',
      }),
    );
    await run('DELETE penalty-waiver (audited)', () =>
      c.delete(`${base(e, item.id)}/grading/learners/${key}/penalty-waiver`),
    );
    await run('POST release (audited)', () => c.post(`${base(e, item.id)}/release`, {}));
    const fileId = ok(await c.get(`${base(e, item.id)}/grading/learners/${key}`)).submissions[0]
      .files[0].fileId;
    await run('GET grading/files/:id', () => c.get(`${base(e, item.id)}/grading/files/${fileId}`));
  });

  it('the ZIP: one manifest transaction (the bytes stream afterwards, one object at a time)', async () => {
    const item = await addAssignment(e, { settings: { dueAt: inHours(24) } });
    for (const l of e.learners) ok(await handIn(e, l, item.id));
    await queue(e, e.instructor, item.id);
    // lookup + BEGIN + manifest + COMMIT; nothing per file
    await run('GET submissions.zip', () =>
      e.instructor.client.get(`${base(e, item.id)}/submissions.zip`),
    );
    void uploadHandIn;
  });
});

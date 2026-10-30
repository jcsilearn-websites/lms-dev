import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { doc, newCourse, newOffering, ok, PDF, person, structure } from './courses-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// QUERY BUDGETS of Step 6 (see query-budget.test.ts for the rules). Every endpoint is one fused
// statement: session lookup + BEGIN + the statement + COMMIT = 4. The documented exception is
// POST /files/:id/confirm = 7 (two short transactions with the storage read between them, so no
// database transaction is held open while bytes are hashed).

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let adminC: TestClient;
let instructor: TestClient;
let learner: TestClient;
let offeringId: string;
let secondOfferingId: string;
let moduleId: string;
let itemId: string;
let sectionId: string;
let courseId: string;
let termId: string;
let instructorUserId: string;
let learnerUserId: string;
let participantId: string;

async function measure(fn: () => Promise<unknown>): Promise<string[]> {
  t.statements.reset();
  await fn();
  await t.app.modules.background.drain();
  return t.statements.statements;
}

const budget = (name: string, statements: string[], max: number) => {
  const listing = statements.map((s) => s.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ');
  process.stdout.write(`ROUND-TRIPS ${name}: ${statements.length} (budget ${max})\n`);
  expect(
    statements.length,
    `${name} used ${statements.length} round trips:\n  ${listing}`,
  ).toBeLessThanOrEqual(max);
};

const run = async (
  name: string,
  fn: () => Promise<{ statusCode: number; body: string }>,
  max = 4,
) => {
  const s = await measure(async () => {
    const r = await fn();
    expect(r.statusCode, `${name}: ${r.body}`).toBeLessThan(300);
  });
  budget(name, s, max);
};

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'qc-a');
  await t.app.ready();
  adminC = new TestClient(t, A.host);
  await adminC.login(A.adminEmail, TEST_PASSWORD);
  const s = await structure(adminC);
  termId = s.termId;
  sectionId = s.sectionA;
  const c = await newCourse(adminC);
  courseId = c.id;
  offeringId = (await newOffering(adminC, c.id, termId)).id;
  secondOfferingId = (await newOffering(adminC, c.id, termId, { label: 'B' })).id;
  const i = await person(owner, t, A, 'BInstructor');
  const l = await person(owner, t, A, 'BLearner');
  instructor = i.client;
  learner = l.client;
  instructorUserId = i.userId;
  learnerUserId = l.userId;
  for (const o of [offeringId, secondOfferingId]) {
    ok(
      await adminC.post(`/offerings/${o}/participants`, {
        userId: i.userId,
        participation: 'instructor',
      }),
    );
  }
  participantId = ok(
    await adminC.post(`/offerings/${offeringId}/participants`, {
      userId: l.userId,
      participation: 'learner',
    }),
  ).id;
  ok(await instructor.post(`/offerings/${offeringId}/publish`));
  const m = ok(
    await instructor.post(`/offerings/${offeringId}/modules`, { title: 'M', published: true }),
  );
  moduleId = m.id;
  itemId = ok(
    await instructor.post(`/offerings/${offeringId}/modules/${m.id}/items`, {
      kind: 'text',
      title: 'T',
      body: doc('hello'),
      published: true,
    }),
  ).id;
  // warm the pool and the slug cache
  await new TestClient(t, A.host).get('/auth/me');
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('round-trip budgets: courses, offerings, content and files (step 6)', () => {
  it('courses: list, get, create, update = 4', async () => {
    await run('GET /courses', () => adminC.get('/courses', { query: 'limit=100' }));
    await run('GET /courses/:id', () => adminC.get(`/courses/${courseId}`));
    await run('POST /courses', () =>
      adminC.post('/courses', { code: `QB${Date.now()}`.slice(0, 20), title: 'Budget' }),
    );
    await run('PATCH /courses/:id', () =>
      adminC.patch(`/courses/${courseId}`, { title: 'Budget 2' }),
    );
  });

  it('offerings: list, get, my courses, create, update, publish, unpublish, archive = 4', async () => {
    await run('GET /offerings', () => adminC.get('/offerings', { query: 'limit=100' }));
    await run('GET /offerings/:id', () => learner.get(`/offerings/${offeringId}`));
    await run('GET /me/courses', () => learner.get('/me/courses'));
    const c = await newCourse(adminC);
    let created = '';
    await run('POST /offerings', async () => {
      const r = await adminC.post('/offerings', { courseId: c.id, termId });
      created = r.json().id;
      return r;
    });
    await run('PATCH /offerings/:id', () => adminC.patch(`/offerings/${created}`, { label: 'x' }));
    ok(
      await adminC.post(`/offerings/${created}/participants`, {
        userId: instructorUserId,
        participation: 'instructor',
      }),
    );
    await run('POST /offerings/:id/publish', () =>
      instructor.post(`/offerings/${created}/publish`),
    );
    await run('POST /offerings/:id/unpublish', () =>
      instructor.post(`/offerings/${created}/unpublish`),
    );
    await run('POST /offerings/:id/archive', () => adminC.post(`/offerings/${created}/archive`));
  });

  it('sections and participants = 4 each', async () => {
    await run('POST /offerings/:id/sections', () =>
      adminC.post(`/offerings/${secondOfferingId}/sections`, { sectionId }),
    );
    await run('GET /offerings/:id/sections', () =>
      adminC.get(`/offerings/${secondOfferingId}/sections`),
    );
    await run('DELETE /offerings/:id/sections/:sectionId', () =>
      adminC.delete(`/offerings/${secondOfferingId}/sections/${sectionId}`),
    );
    await run('GET /offerings/:id/participants', () =>
      instructor.get(`/offerings/${offeringId}/participants`),
    );
    await run('POST /offerings/:id/participants', () =>
      adminC.post(`/offerings/${secondOfferingId}/participants`, {
        userId: learnerUserId,
        participation: 'learner',
      }),
    );
    await run('PATCH /offerings/:id/participants/:pid', () =>
      adminC.patch(`/offerings/${offeringId}/participants/${participantId}`, {
        participation: 'learner',
      }),
    );
    await run('DELETE /offerings/:id/participants/:pid', () =>
      adminC.delete(`/offerings/${offeringId}/participants/${participantId}`),
    );
  });

  it('content: outline, item, modules and items = 4', async () => {
    await run('GET /offerings/:id/outline', () =>
      instructor.get(`/offerings/${offeringId}/outline`),
    );
    await run('GET /offerings/:id/items/:itemId', () =>
      instructor.get(`/offerings/${offeringId}/items/${itemId}`),
    );
    let mod = '';
    await run('POST /offerings/:id/modules', async () => {
      const r = await instructor.post(`/offerings/${offeringId}/modules`, {
        title: 'Budget module',
      });
      mod = r.json().id;
      return r;
    });
    await run('PATCH .../modules/:moduleId', () =>
      instructor.patch(`/offerings/${offeringId}/modules/${mod}`, { title: 'b2' }),
    );
    await run('POST .../modules/:moduleId/move', () =>
      instructor.post(`/offerings/${offeringId}/modules/${mod}/move`, { after: null }),
    );
    let item = '';
    await run('POST .../modules/:moduleId/items', async () => {
      const r = await instructor.post(`/offerings/${offeringId}/modules/${mod}/items`, {
        kind: 'text',
        title: 'x',
        body: doc('y'),
      });
      item = r.json().id;
      return r;
    });
    await run('PATCH .../items/:itemId', () =>
      instructor.patch(`/offerings/${offeringId}/items/${item}`, { title: 'x2', body: doc('z') }),
    );
    await run('POST .../items/:itemId/move', () =>
      instructor.post(`/offerings/${offeringId}/items/${item}/move`, { moduleId, after: null }),
    );
    await run('DELETE .../items/:itemId', () =>
      instructor.delete(`/offerings/${offeringId}/items/${item}`),
    );
    await run('DELETE .../modules/:moduleId', () =>
      instructor.delete(`/offerings/${offeringId}/modules/${mod}`),
    );
  });

  it('the learner outline of 20 modules x 15 items is ONE statement: 4 round trips including authentication', async () => {
    const c = await newCourse(adminC);
    const o = await newOffering(adminC, c.id, termId, { label: 'big' });
    ok(
      await adminC.post(`/offerings/${o.id}/participants`, {
        userId: learnerUserId,
        participation: 'learner',
      }),
    );
    ok(
      await adminC.post(`/offerings/${o.id}/participants`, {
        userId: instructorUserId,
        participation: 'instructor',
      }),
    );
    ok(await instructor.post(`/offerings/${o.id}/publish`));
    await owner.query(
      `WITH mods AS (
         INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published)
         SELECT gen_random_uuid(), $1, $2, 'Module ' || g, 'm' || to_char(g, 'FM0000') || 'x', true
           FROM generate_series(1, 20) g RETURNING id)
       INSERT INTO lms.content_items (id, tenant_id, offering_id, module_id, kind, title, position, body, published)
       SELECT gen_random_uuid(), $1, $2, m.id, 'text', 'Item ' || i, 'i' || to_char(i, 'FM0000') || 'x',
              '{"type":"doc"}'::jsonb, true
         FROM mods m, generate_series(1, 15) i`,
      [A.tenantId, o.id],
    );
    const out = ok(await learner.get(`/offerings/${o.id}/outline`));
    expect(out.modules).toHaveLength(20);
    expect(out.modules[0].items).toHaveLength(15);
    await run('GET /offerings/:id/outline (20 x 15)', () =>
      learner.get(`/offerings/${o.id}/outline`),
    );
  });

  it('copy (inline): 4; upload request: 4; the storage PUT: 1; confirm: 7 (documented exception)', async () => {
    await run('POST /offerings/:id/copy', () =>
      instructor.post(`/offerings/${secondOfferingId}/copy`, { sourceOfferingId: offeringId }),
    );
    let fileId = '';
    let uploadUrl = '';
    await run('POST /offerings/:id/files', async () => {
      const r = await instructor.post(`/offerings/${offeringId}/files`, {
        name: 'b.pdf',
        size: PDF.length,
      });
      fileId = r.json().file.id;
      uploadUrl = r.json().upload.url;
      return r;
    });
    // the local storage route reads no table at all (tenant slug cache warm)
    await run(
      'PUT /storage/upload/:token',
      () =>
        instructor.request('PUT', uploadUrl, {
          body: PDF,
          headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.length) },
        }),
      1,
    );
    await run('POST /files/:id/confirm', () => instructor.post(`/files/${fileId}/confirm`), 7);
  });
});

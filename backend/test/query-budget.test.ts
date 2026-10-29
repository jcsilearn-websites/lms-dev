import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { addMember } from './fixtures';
import { csv, STUDENT_HEADER, upload } from './imports-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// QUERY BUDGETS. Every statement sent to Postgres is a network round trip (~1 ms on Cloud SQL in the
// same region, ~200 ms from a laptop to the remote dev DB). These tests count them per request,
// including BEGIN / set_config / COMMIT and background bookkeeping the request triggers, and fail
// when an endpoint exceeds its budget. Adding a round trip to a hot endpoint needs a reason; adding a
// new endpoint needs a budget test here (see CLAUDE.md "Round-trip budget").
//
// Steady state: the tenant slug cache is warm and the connection pool is warm.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let platform: { userId: string; email: string };

beforeAll(async () => {
  owner = testOwnerPool();
  // the budgets are STEADY STATE (slug cache warm): a long TTL keeps that true however long this file runs
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'qb-a');
  platform = await createPlatformAdmin(owner, 'qb-root@platform.test');
  await t.app.ready();
  // warm the pool and the tenant slug cache
  await new TestClient(t, A.host).get('/auth/me');
  await new TestClient(t, 'admin.localhost').get('/auth/me');
  await t.app.inject({ method: 'GET', url: '/health/ready' });
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

/** Runs `fn`, waits for deferred background work it triggered, and returns the statements sent. */
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

describe('round-trip budgets', () => {
  it('GET /health/ready: 1', async () => {
    const s = await measure(() => t.app.inject({ method: 'GET', url: '/health/ready' }));
    budget('GET /health/ready', s, 1);
  });

  it('GET /auth/me (authenticated): at most 2 for the whole request', async () => {
    const c = new TestClient(t, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    const s = await measure(() => c.get('/auth/me'));
    budget('GET /auth/me', s, 2);
  });

  it('GET /auth/me on the admin host: at most 2', async () => {
    const c = new TestClient(t, 'admin.localhost');
    await c.login(platform.email, TEST_PASSWORD);
    const s = await measure(() => c.get('/auth/me'));
    budget('GET /auth/me (admin host)', s, 2);
  });

  it('POST /auth/login (success): at most 4 including deferred bookkeeping', async () => {
    const c = new TestClient(t, A.host);
    const s = await measure(() => c.login(A.memberEmail, TEST_PASSWORD));
    budget('POST /auth/login (success)', s, 4);
  });

  it('POST /auth/login on the admin host (success): at most 4', async () => {
    const c = new TestClient(t, 'admin.localhost');
    const s = await measure(() => c.login(platform.email, TEST_PASSWORD));
    budget('POST /auth/login (admin host)', s, 4);
  });

  it('POST /auth/login (wrong password): at most 4', async () => {
    const c = new TestClient(t, A.host);
    const s = await measure(() => c.login(A.memberEmail, 'not the right password'));
    budget('POST /auth/login (wrong password)', s, 4);
  });

  it('POST /auth/login (unknown email): at most 4', async () => {
    const c = new TestClient(t, A.host);
    const s = await measure(() => c.login('nobody@qb-a.test', 'not the right password'));
    budget('POST /auth/login (unknown email)', s, 4);
  });

  it('POST /auth/logout: at most 3', async () => {
    const c = new TestClient(t, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    const s = await measure(() => c.post('/auth/logout'));
    budget('POST /auth/logout', s, 3);
  });

  it('GET /auth/sessions (authenticated tenant read): session lookup 1 + one transaction of 3', async () => {
    const c = new TestClient(t, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    const s = await measure(() => c.get('/auth/sessions'));
    budget('GET /auth/sessions', s, 4);
  });

  it('a request that fails authentication costs at most 1 round trip (no session found)', async () => {
    const c = new TestClient(t, A.host);
    c.cookies.set('sid', 'x'.repeat(43));
    const s = await measure(() => c.get('/auth/me'));
    budget('GET /auth/me (bad cookie)', s, 1);
  });

  it('requests without a cookie cost 0 round trips (tenant slug is cached)', async () => {
    const c = new TestClient(t, A.host);
    const s = await measure(() => c.get('/auth/me'));
    budget('GET /auth/me (no cookie)', s, 0);
  });
});

// ---------------------------------------------------------------------------------------- step 4
// Authorization is account-level (zero queries), so every tenant endpoint costs: 1 (session lookup)
// + 1 (BEGIN + set_config in one message) + the work + 1 (COMMIT). A list = ONE query for the page
// (the user is joined; no query per row). Every mutation is ONE statement (data-modifying CTEs:
// lock + update + revoke sessions + audit entry). Platform endpoints are one SECURITY DEFINER call
// on an autocommit connection: 1 (lookup) + 1.
describe('round-trip budgets: member management and platform tenants', () => {
  let admin: TestClient;
  let root: TestClient;
  let n = 0;
  const email = (p: string) => `${p}${++n}@qb-a.test`;

  beforeAll(async () => {
    admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
    root = new TestClient(t, 'admin.localhost');
    await root.login(platform.email, TEST_PASSWORD);
  });

  const patch = (c: TestClient, url: string, body: unknown) => c.request('PATCH', url, { body });

  it('GET /members: 4 (lookup + transaction of 3), and the page size does not change it (no N+1)', async () => {
    for (let i = 0; i < 12; i++) await addMember(owner, A.tenantId, email('page'));
    const small = await measure(() => admin.get('/members', { query: 'limit=2' }));
    const big = await measure(() => admin.get('/members', { query: 'limit=50' }));
    budget('GET /members (2 rows)', small, 4);
    budget('GET /members (50 rows)', big, 4);
    expect(big.length).toBe(small.length);
  });

  it('GET /members with role + status + prefix search: 4', async () => {
    const s = await measure(() =>
      admin.get('/members', { query: 'role=member&status=active&q=page&limit=50' }),
    );
    budget('GET /members?role&status&q', s, 4);
  });

  it('GET /members/:userId: 4', async () => {
    const s = await measure(() => admin.get(`/members/${A.memberUserId}`));
    budget('GET /members/:userId', s, 4);
  });

  it('PATCH /members/:userId/role: 4 (one fused statement)', async () => {
    const u = await addMember(owner, A.tenantId, email('role'));
    const s = await measure(() =>
      patch(admin, `/members/${u.userId}/role`, { role: 'institution_admin' }),
    );
    budget('PATCH /members/:userId/role', s, 4);
  });

  it('POST /members/:userId/suspend and /reactivate: 4 each', async () => {
    const u = await addMember(owner, A.tenantId, email('sus'));
    budget(
      'POST /members/:userId/suspend',
      await measure(() => admin.post(`/members/${u.userId}/suspend`)),
      4,
    );
    budget(
      'POST /members/:userId/reactivate',
      await measure(() => admin.post(`/members/${u.userId}/reactivate`)),
      4,
    );
  });

  it('DELETE /members/:userId: 4', async () => {
    const u = await addMember(owner, A.tenantId, email('del'));
    budget('DELETE /members/:userId', await measure(() => admin.delete(`/members/${u.userId}`)), 4);
  });

  it('POST /members/:userId/resend-invite: 4', async () => {
    const u = await addMember(owner, A.tenantId, email('res'), { status: 'pending' });
    budget(
      'POST /members/:userId/resend-invite',
      await measure(() => admin.post(`/members/${u.userId}/resend-invite`)),
      4,
    );
  });

  it('GET /audit: 4 (filters and date range included)', async () => {
    const s = await measure(() =>
      admin.get('/audit', { query: 'action=member.suspended&from=2020-01-01T00:00:00Z&limit=50' }),
    );
    budget('GET /audit', s, 4);
  });

  it('GET /platform/tenants and /platform/tenants/:id: 2 (lookup + one definer call)', async () => {
    budget(
      'GET /platform/tenants',
      await measure(() => root.get('/platform/tenants', { query: 'limit=50' })),
      2,
    );
    budget(
      'GET /platform/tenants?q',
      await measure(() => root.get('/platform/tenants', { query: 'q=qb' })),
      2,
    );
    budget(
      'GET /platform/tenants/:id',
      await measure(() => root.get(`/platform/tenants/${A.tenantId}`)),
      2,
    );
  });

  it('GET /platform/audit: 2', async () => {
    budget(
      'GET /platform/audit',
      await measure(() => root.get('/platform/audit', { query: 'limit=50' })),
      2,
    );
  });

  it('POST /platform/tenants: at most 3 (create + read-back; the invite mail is not a query)', async () => {
    const slug = `qb-new-${Date.now().toString(36)}`;
    const s = await measure(() =>
      root.post('/platform/tenants', {
        name: 'QB College',
        slug,
        adminEmail: `first@${slug}.test`,
        adminName: 'First',
      }),
    );
    budget('POST /platform/tenants', s, 3);
  });

  it('PATCH, suspend and reactivate a tenant: 2 each (one definer call)', async () => {
    const f = await createAuthFixture(owner, `qb-p-${Date.now().toString(36)}`);
    budget(
      'PATCH /platform/tenants/:id',
      await measure(() => patch(root, `/platform/tenants/${f.tenantId}`, { name: 'Renamed' })),
      2,
    );
    budget(
      'POST /platform/tenants/:id/suspend',
      await measure(() => root.post(`/platform/tenants/${f.tenantId}/suspend`)),
      2,
    );
    budget(
      'POST /platform/tenants/:id/reactivate',
      await measure(() => root.post(`/platform/tenants/${f.tenantId}/reactivate`)),
      2,
    );
  });

  it('POST /platform/tenants/:id/admin-invite: at most 3', async () => {
    const f = await createAuthFixture(owner, `qb-i-${Date.now().toString(36)}`);
    const s = await measure(() =>
      root.post(`/platform/tenants/${f.tenantId}/admin-invite`, {
        email: 'new-admin@qb-invite.test',
        displayName: 'New Admin',
      }),
    );
    budget('POST /platform/tenants/:id/admin-invite', s, 3);
  });

  it('GET /platform/tenants/:id/members (audited read): at most 6', async () => {
    const s = await measure(() =>
      root.get(`/platform/tenants/${A.tenantId}/members`, { query: 'limit=50' }),
    );
    budget('GET /platform/tenants/:id/members', s, 6);
  });
});

// ---------------------------------------------------------------------------------------- step 5
// Academic structure: reads are lookup + one transaction of 3 = 4 (a page is ONE query, no matter
// how many rows); every change is ONE statement (lock + change + audit entry) = 4.
describe('round-trip budgets: academic structure', () => {
  let admin: TestClient;
  let n = 0;
  const uniq = (p: string) => `${p}${++n}${Date.now().toString(36).slice(-4)}`.toUpperCase();

  beforeAll(async () => {
    admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
  });

  async function mk(url: string, body: unknown) {
    const res = await admin.post(url, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }

  it('GET /departments: 4 whatever the page size (no N+1); filters cost nothing extra', async () => {
    for (let i = 0; i < 6; i++) await mk('/departments', { code: uniq('D'), name: 'Dept' });
    const small = await measure(() => admin.get('/departments', { query: 'limit=2' }));
    const big = await measure(() => admin.get('/departments', { query: 'limit=100&archived=all' }));
    budget('GET /departments (2 rows)', small, 4);
    budget('GET /departments (all rows)', big, 4);
    expect(big.length).toBe(small.length);
    const dep = await mk('/departments', { code: uniq('D'), name: 'Dept' });
    budget(
      'GET /programs?departmentId',
      await measure(() => admin.get('/programs', { query: `departmentId=${dep.id}` })),
      4,
    );
    budget(
      'GET /sections?batchId',
      await measure(() => admin.get('/sections', { query: `batchId=${dep.id}` })),
      4,
    );
  });

  it('GET /departments/:id: 4', async () => {
    const dep = await mk('/departments', { code: uniq('D'), name: 'Dept' });
    budget('GET /departments/:id', await measure(() => admin.get(`/departments/${dep.id}`)), 4);
  });

  it('create, update, archive, unarchive, delete: 4 each (one fused statement)', async () => {
    const code = uniq('D');
    let id = '';
    budget(
      'POST /departments',
      await measure(async () => {
        id = (await mk('/departments', { code, name: 'Dept' })).id;
      }),
      4,
    );
    budget(
      'PATCH /departments/:id',
      await measure(() => admin.request('PATCH', `/departments/${id}`, { body: { name: 'New' } })),
      4,
    );
    budget(
      'POST /departments/:id/archive',
      await measure(() => admin.post(`/departments/${id}/archive`)),
      4,
    );
    budget(
      'POST /departments/:id/unarchive',
      await measure(() => admin.post(`/departments/${id}/unarchive`)),
      4,
    );
    budget('DELETE /departments/:id', await measure(() => admin.delete(`/departments/${id}`)), 4);
  });

  it('POST /academic-years/:id/set-current: 4', async () => {
    const y = await mk('/academic-years', {
      label: uniq('Y'),
      startDate: '2070-06-01',
      endDate: '2071-05-31',
    });
    budget(
      'POST /academic-years/:id/set-current',
      await measure(() => admin.post(`/academic-years/${y.id}/set-current`)),
      4,
    );
  });
});

// Member profiles: a read is lookup + one transaction of 3 = 4; the upsert and the section moves are ONE
// statement (lock + change + audit) = 4, however many students a bulk move touches.
describe('round-trip budgets: member profiles', () => {
  let admin: TestClient;
  let student: TestClient;
  let studentId = '';
  let sectionA = '';
  let sectionB = '';
  let n = 0;
  const uniq = (p: string) => `${p}${++n}${Date.now().toString(36).slice(-4)}`.toUpperCase();

  beforeAll(async () => {
    admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const mk = async (url: string, body: unknown) =>
      (await admin.post(url, body)).json() as { id: string };
    const d = await mk('/departments', { code: uniq('D'), name: 'Dept' });
    const p = await mk('/programs', {
      departmentId: d.id,
      code: uniq('P'),
      name: 'Prog',
      durationYears: 4,
    });
    const b = await mk('/batches', { programId: p.id, admissionYear: 2023, graduationYear: 2027 });
    sectionA = (await mk('/sections', { batchId: b.id, code: 'A' })).id;
    sectionB = (await mk('/sections', { batchId: b.id, code: 'B' })).id;
    const u = await addMember(owner, A.tenantId, `stu${Date.now().toString(36)}@qb-a.test`);
    studentId = u.userId;
    const r = await admin.request('PATCH', `/members/${studentId}/profile`, {
      body: {
        profileType: 'student',
        registerNumber: uniq('REG'),
        batchId: b.id,
        sectionId: sectionA,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    student = new TestClient(t, A.host);
    await student.login(u.email, TEST_PASSWORD);
  });

  it('GET /members/:userId/profile and GET /me/profile: 4', async () => {
    budget(
      'GET /members/:userId/profile',
      await measure(() => admin.get(`/members/${studentId}/profile`)),
      4,
    );
    budget('GET /me/profile', await measure(() => student.get('/me/profile')), 4);
  });

  it('PATCH /members/:userId/profile (upsert): 4', async () => {
    budget(
      'PATCH /members/:userId/profile',
      await measure(() =>
        admin.request('PATCH', `/members/${studentId}/profile`, { body: { phone: '98765 43210' } }),
      ),
      4,
    );
  });

  it('section moves, single and bulk: 4 each', async () => {
    budget(
      'POST /members/:userId/profile/section',
      await measure(() =>
        admin.post(`/members/${studentId}/profile/section`, { sectionId: sectionB }),
      ),
      4,
    );
    budget(
      'POST /sections/move (bulk)',
      await measure(() =>
        admin.post('/sections/move', { userIds: [studentId], sectionId: sectionA }),
      ),
      4,
    );
  });

  it('GET /members filtered by profile type / department / batch / section: 4', async () => {
    budget(
      'GET /members?sectionId&profileType',
      await measure(() =>
        admin.get('/members', { query: `sectionId=${sectionA}&profileType=student&limit=50` }),
      ),
      4,
    );
  });
});

// Bulk import: reads are lookup + one transaction (4); the review of rows reads the import and its page
// in ONE transaction (5); confirm and cancel are one statement (4). An upload costs a fixed handful plus
// ONE statement per 1,000 rows staged, whatever the file.
describe('round-trip budgets: bulk import', () => {
  let admin: TestClient;
  let importId = '';

  beforeAll(async () => {
    admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const mk = async (url: string, body: unknown) =>
      (await admin.post(url, body)).json() as { id: string };
    const d = await mk('/departments', {
      code: `IMP${Date.now().toString(36)}`.toUpperCase(),
      name: 'Dept',
    });
    const p = await mk('/programs', {
      departmentId: d.id,
      code: `IP${Date.now().toString(36)}`.toUpperCase(),
      name: 'Prog',
      durationYears: 4,
    });
    const b = await mk('/batches', { programId: p.id, admissionYear: 2021, graduationYear: 2025 });
    await mk('/sections', { batchId: b.id, code: 'A' });
  });

  const rows = (n: number, tag: string) => async () => {
    const dept = await admin.get('/departments', { query: 'limit=100&archived=all' });
    const d = (dept.json().items as { code: string }[]).find((x) => x.code.startsWith('IMP'));
    const prog = (await admin.get('/programs', { query: 'limit=100' }))
      .json()
      .items.find((x: { code: string }) => x.code.startsWith('IP'));
    return Array.from({ length: n }, (_, i) => [
      `${tag}${i}@qb-imp.test`,
      `Name ${i}`,
      `${tag.toUpperCase()}-${i}`,
      d?.code ?? '',
      prog?.code ?? '',
      '2021-2025',
      'A',
    ]);
  };

  it('POST /imports: a fixed handful + 1 per 1,000 rows (10 rows and 2,500 rows)', async () => {
    const small = await rows(10, 'qa')();
    const smallS = await measure(async () => {
      const res = await upload(admin, 'students', csv(STUDENT_HEADER, small));
      expect(res.statusCode, res.body).toBe(201);
      importId = res.json().id;
    });
    budget('POST /imports (10 rows)', smallS, 7 + 1);
    const big = await rows(2500, 'qb')();
    const bigS = await measure(async () => {
      const res = await upload(admin, 'students', csv(STUDENT_HEADER, big));
      expect(res.statusCode, res.body).toBe(201);
    });
    budget('POST /imports (2,500 rows)', bigS, 7 + 3);
    expect(bigS.length - smallS.length).toBe(2); // two more 1,000-row batches, nothing else
  });

  it('GET /imports, /imports/:id: 4; the template: 1 (static)', async () => {
    budget('GET /imports', await measure(() => admin.get('/imports', { query: 'limit=50' })), 4);
    budget('GET /imports/:id', await measure(() => admin.get(`/imports/${importId}`)), 4);
    budget(
      'GET /imports/templates/students.csv',
      await measure(() => admin.get('/imports/templates/students.csv')),
      1,
    );
  });

  it('GET /imports/:id/rows and /errors.csv: 5 (the import and its page in one transaction)', async () => {
    budget(
      'GET /imports/:id/rows',
      await measure(() => admin.get(`/imports/${importId}/rows`, { query: 'limit=100' })),
      5,
    );
    // a clean file has no error rows: the report is only the header line
    const s = await measure(() => admin.get(`/imports/${importId}/errors.csv`));
    expect(s.length).toBeLessThanOrEqual(5);
  });

  it('POST /imports/:id/cancel: 4', async () => {
    budget(
      'POST /imports/:id/cancel',
      await measure(() => admin.post(`/imports/${importId}/cancel`)),
      4,
    );
  });

  it('POST /imports/:id/confirm: 4 (state change + the queue job + audit in one statement)', async () => {
    const res = await upload(admin, 'students', csv(STUDENT_HEADER, await rows(3, 'qc')()));
    const id = res.json().id as string;
    budget(
      'POST /imports/:id/confirm',
      await measure(() => admin.post(`/imports/${id}/confirm`, {})),
      4,
    );
    // leave no running import behind: it would block later tests
    await owner.query("UPDATE lms.import_jobs SET status = 'cancelled' WHERE id = $1", [id]);
  });
});

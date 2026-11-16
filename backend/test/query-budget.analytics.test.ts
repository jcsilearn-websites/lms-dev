// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { classOf } from './assignments-helpers';
import { TestClient } from './client';
import { loginAs, ok, type Structure, structure } from './courses-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// QUERY BUDGETS of Step 12 (see query-budget.test.ts for the rules). Every staff / report call is the session lookup + ONE
// transaction with ONE fused statement = 4. The learner dashboard is the lookup + ONE definer call = 2. Platform reads are the
// lookup + one definer call = 2. Activity: the first request of a local day adds ONE background statement, every later one none.
// The heartbeat stays at 2 (the watch log is written inside the same definer call).

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let root: TestClient;
let st: Structure;
let offeringId: string;
let instructor: TestClient;
let learner: TestClient;

async function measure(fn: () => Promise<unknown>, raw = false): Promise<string[]> {
  t.statements.reset();
  await fn();
  await t.app.modules.background.drain();
  return raw ? t.statements.raw : t.statements.statements;
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
  A = await createAuthFixture(owner, 'an-bud');
  const plat = await createPlatformAdmin(owner, 'root@anbud.test');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  root = new TestClient(t, 'admin.localhost');
  expect((await root.login(plat.email, TEST_PASSWORD)).statusCode).toBe(200);
  st = await structure(admin);
  const e = await classOf(owner, t, A, admin, st, ['One', 'Two']);
  offeringId = e.offeringId;
  instructor = e.instructor.client;
  learner = e.learners[0]!.client;
  await t.app.modules.analytics.service.refreshTenant(A.tenantId);
  // warm: slug cache, the activity cache of every caller
  for (const c of [instructor, learner, admin]) await c.get('/me/dashboard').catch(() => null);
  await t.app.modules.background.drain();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('learner and instructor dashboards', () => {
  it('learner dashboard: 2 (lookup + one definer call)', async () => {
    await run('GET /me/dashboard', () => learner.get('/me/dashboard'), 2);
  });
  it('instructor: offering dashboard, teaching dashboard, at-risk and its exports: 4', async () => {
    await run('GET /offerings/:id/dashboard', () =>
      instructor.get(`/offerings/${offeringId}/dashboard`),
    );
    await run('GET /me/teaching/dashboard', () => instructor.get('/me/teaching/dashboard'));
    await run('GET /offerings/:id/at-risk', () =>
      instructor.get(`/offerings/${offeringId}/at-risk`),
    );
    // an export streams after its first page: 4 + 3 per further page (one page here)
    await run('GET /offerings/:id/at-risk.csv', () =>
      instructor.get(`/offerings/${offeringId}/at-risk.csv`),
    );
    await run('GET /offerings/:id/at-risk.xlsx', () =>
      instructor.get(`/offerings/${offeringId}/at-risk.xlsx`),
    );
  });
});

describe('institution admin reports', () => {
  it('every report table, active users, settings read and every export: 4', async () => {
    for (const id of [
      'activity',
      'organisation',
      'course-health',
      'gradebooks',
      'grading-backlog',
      'at-risk',
      'resources',
    ])
      await run(`GET /reports/${id}`, () => admin.get(`/reports/${id}`));
    await run('GET /reports/active-users', () => admin.get('/reports/active-users'));
    await run('GET /analytics/settings', () => admin.get('/analytics/settings'));
    await run('GET /reports/at-risk/export (csv)', () =>
      admin.get('/reports/at-risk/export', { query: 'format=csv' }),
    );
    await run('GET /reports/at-risk/export (xlsx)', () =>
      admin.get('/reports/at-risk/export', { query: 'format=xlsx' }),
    );
  });
  it('changing the settings reads, merges and writes: 5 (a rare admin action: the reason is the merge with what is stored)', async () => {
    await run(
      'PATCH /analytics/settings',
      () => admin.request('PATCH', '/analytics/settings', { body: { courseHealthWeeks: 4 } }),
      5,
    );
  });
});

describe('platform', () => {
  it('usage and its export: 2 (lookup + one definer call)', async () => {
    await run('GET /platform/usage', () => root.get('/platform/usage'), 2);
    await run(
      'GET /platform/usage/export',
      () => root.get('/platform/usage/export', { query: 'format=csv' }),
      2,
    );
  });
});

describe('activity tracking costs at most one write per user and local day', () => {
  it('the first request of a day adds one background statement; later requests add none', async () => {
    const svc = t.app.modules.analytics.service;
    svc.resetActivityCache();
    const first = await measure(() => learner.get('/me/dashboard'), true);
    expect(first.filter((s) => s.includes('activity_touch'))).toHaveLength(1);
    expect(first.length).toBe(3); // the 2 of the dashboard + the activity upsert
    for (let i = 0; i < 3; i++) {
      const later = await measure(() => learner.get('/me/dashboard'), true);
      expect(later.length).toBe(2);
    }
  });
});

describe('the heartbeat is still 2 round trips with the watch log inside the same call', () => {
  it('2', async () => {
    const e = await classOf(owner, t, A, admin, st, ['Beat']);
    const videoId = '00000000-0000-7000-8000-0000000000b1';
    await owner.query(
      `INSERT INTO lms.video_assets (id, tenant_id, offering_id, created_by, original_name, declared_size, status, duration_ms, hls_prefix, ready_at, upload_offset, progress, renditions)
       VALUES ($1,$2,$3,$4,'p.mp4',1000,'ready',100000,'x',now(),1000,100,'[]'::jsonb) ON CONFLICT DO NOTHING`,
      [videoId, A.tenantId, e.offeringId, e.instructor.userId],
    );
    const item = ok(
      await e.instructor.client.post(`/offerings/${e.offeringId}/modules/${e.moduleId}/items`, {
        kind: 'video',
        title: 'L',
        videoId,
        published: true,
      }),
    );
    const who = e.learners[0]!.client;
    await who.get('/me/dashboard');
    await t.app.modules.background.drain(); // today's activity row is written now, not inside the measured call
    let seq = 0;
    await run(
      'POST heartbeat',
      () =>
        who.post(`/offerings/${e.offeringId}/items/${item.id}/progress/heartbeat`, {
          videoId,
          streamId: '0a000000-0000-7000-8000-00000000000a',
          seq: ++seq,
          ranges: [[0, 20]],
          position: 20,
          rate: 1,
        }),
      2,
    );
    expect(true).toBe(true);
  });
});

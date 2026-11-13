// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import { type Json, loginAs, ok, type Structure, structure } from './courses-helpers';
import { base, type Class, gradebookClass, participantIds, quiz } from './gradebook-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// QUERY BUDGETS of Step 11 (see query-budget.test.ts for the rules). Every staff call is the session lookup + ONE transaction
// with ONE fused statement (access check and work together) = 4. The learner's call is the lookup + ONE definer call = 2.
// An export streams after its first statement: 4 + 3 per page of 500 learners (a short transaction per page).

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let st: Structure;
let e: Class;
let b: string;
let pids: string[];
let items: Record<string, string> = {};
let cats: Record<string, string> = {};

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
  A = await createAuthFixture(owner, 'gb-bud');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  st = await structure(admin);
  e = await gradebookClass(owner, t, A, admin, st, ['Bud One', 'Bud Two', 'Bud Three']);
  pids = await participantIds(owner, e.offeringId, e.learners);
  b = base(e.offeringId);
  const ic = e.instructor.client;
  const cfg = ok(
    await ic.put(`${b}/categories`, {
      categories: [
        { name: 'Tests', weight: 70, dropLowest: 0, missingPolicy: 'exclude' },
        { name: 'Quizzes', weight: 30, dropLowest: 0, missingPolicy: 'exclude' },
      ],
    }),
  );
  cats = Object.fromEntries(cfg.categories.map((c: Json) => [c.name, c.id]));
  const qz = await quiz(e, 'Budget quiz', [true, false, true]);
  const g = ok(
    await ic.put(`${b}/items`, {
      items: [
        {
          source: 'manual',
          title: 'Test 1',
          categoryId: cats.Tests,
          points: 50,
          extraCredit: false,
          released: true,
          assistantsMayEnter: true,
        },
        {
          source: 'assessment',
          contentItemId: qz.id,
          categoryId: cats.Quizzes,
          points: 10,
          extraCredit: false,
        },
      ],
    }),
  );
  items = Object.fromEntries(g.items.map((i: Json) => [i.title, i.id]));
  const scale = ok(
    await admin.post('/grade-scales', {
      name: 'Budget scale',
      bands: [
        { minPercent: 0, label: 'F', isPass: false },
        { minPercent: 50, label: 'P', isPass: true },
      ],
    }),
  );
  ok(await ic.patch(`${b}/settings`, { weighted: true, scaleId: scale.id }));
  await admin.get('/auth/me'); // warm the pool and the slug cache
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

describe('round-trip budgets: gradebook (step 11)', () => {
  it('structure and reads: every call is 4', async () => {
    const c = e.instructor.client;
    await run('GET gradebook', () => c.get(b));
    await run('GET gradebook/review', () => c.get(`${b}/review`));
    await run('PATCH gradebook/settings', () => c.patch(`${b}/settings`, { outOf: 40 }));
    await run('PUT gradebook/categories', async () => {
      const g = ok(await c.get(b));
      t.statements.reset();
      return c.put(`${b}/categories`, { categories: g.categories });
    });
    await run('PUT gradebook/items', async () => {
      const g = ok(await c.get(b));
      t.statements.reset();
      return c.put(`${b}/items`, { items: g.items });
    });
    await run('GET gradebook/grid', () => c.get(`${b}/grid`));
    await run('GET gradebook/learners/:id', () => c.get(`${b}/learners/${pids[0]}`));
  });

  it('marks, the CSV import and overrides: every call is 4', async () => {
    const c = e.instructor.client;
    await run('PUT gradebook/marks (30 cells)', () =>
      c.put(`${b}/marks`, {
        cells: pids.map((p, i) => ({
          itemId: items['Test 1'],
          participantId: p,
          points: String(20 + i),
        })),
      }),
    );
    let imp: Json = {};
    await run('POST gradebook/mark-imports', async () => {
      const r = await c.post(`${b}/mark-imports`, {
        csv: `register_number,Test 1\n${e.register.map((r2, i) => `${r2},${30 + i}`).join('\n')}`,
      });
      imp = r.statusCode < 300 ? r.json() : {};
      return r;
    });
    await run('GET gradebook/mark-imports/:id', () => c.get(`${b}/mark-imports/${imp.importId}`));
    await run('POST gradebook/mark-imports/:id/apply', () =>
      c.post(`${b}/mark-imports/${imp.importId}/apply`, {}),
    );
    await run('PUT gradebook/learners/:id/override', () =>
      c.put(`${b}/learners/${pids[0]}/override`, {
        itemId: items['Test 1'],
        points: '45',
        reason: 'Re-test result',
      }),
    );
    await run('DELETE gradebook/learners/:id/override', () =>
      c.delete(`${b}/learners/${pids[0]}/override?itemId=${items['Test 1']}`),
    );
  });

  it('the workflow: submit, return, approve, unlock are 4; the export is 4 + 3 per page', async () => {
    const c = e.instructor.client;
    await run('POST gradebook/submit', () => c.post(`${b}/submit`));
    await run('POST gradebook/return', () =>
      admin.post(`${b}/return`, { comment: 'Check again please' }),
    );
    ok(await c.post(`${b}/submit`));
    await run('POST gradebook/approve', () => admin.post(`${b}/approve`, {}));
    await run(
      'GET me/grades (approved record)',
      () => e.learners[0]!.client.get(`/offerings/${e.offeringId}/me/grades`),
      2,
    );
    await run('GET gradebook/export.csv', () => admin.get(`${b}/export.csv`), 7);
    await run('GET gradebook/export.xlsx', () => admin.get(`${b}/export.xlsx`), 7);
    await run('GET gradebook/queue', () => admin.get('/gradebook/queue?status=locked'));
    await run('POST gradebook/unlock', () =>
      admin.post(`${b}/unlock`, { reason: 'Budget test unlock' }),
    );
    await run(
      'GET me/grades (provisional)',
      () => e.learners[1]!.client.get(`/offerings/${e.offeringId}/me/grades`),
      2,
    );
  });

  it('the college setting and the grade scales: 4', async () => {
    await run('GET gradebook/settings', () => admin.get('/gradebook/settings'));
    await run('PATCH gradebook/settings', () =>
      admin.patch('/gradebook/settings', { allowSelfApproval: false }),
    );
    await run('GET grade-scales', () => admin.get('/grade-scales'));
    let made: Json = {};
    const bands = [
      { minPercent: 0, label: 'F', isPass: false },
      { minPercent: 40, label: 'P', isPass: true },
    ];
    await run('POST grade-scales', async () => {
      const r = await admin.post('/grade-scales', { name: 'Budget 2', bands });
      made = r.statusCode < 300 ? r.json() : {};
      return r;
    });
    await run('PUT grade-scales/:id', () =>
      admin.put(`/grade-scales/${made.id}`, { name: 'Budget 2b', bands }),
    );
    await run('PATCH grade-scales/:id', () =>
      admin.patch(`/grade-scales/${made.id}`, { archived: true }),
    );
  });
});

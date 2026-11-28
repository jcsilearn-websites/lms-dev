import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeContract } from '../src/core/__tests__/store-contract';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// The SHARED rate limiter (step 14a, docs/adr/0022): PostgreSQL store contract, limits that hold ACROSS API instances, and the
// pinned round-trip cost of both tiers.

let owner: pg.Pool;
let A: AuthFixture;
const apps: TestApp[] = [];
const app = (env: Record<string, string> = {}) => {
  const t = makeApp({ env: { RATE_LIMIT_STORE: 'postgres', ...env } });
  apps.push(t);
  return t;
};

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'rls-a');
});
beforeEach(async () => {
  await owner.query('TRUNCATE lms.rate_limit_counters');
});
afterAll(async () => {
  for (const t of apps) await t.close();
  await owner.end();
});

describe('PostgreSQL store', () => {
  it('meets the store contract (counts, batches, independent keys, a new window)', async () => {
    const t = app();
    await t.app.ready();
    // the window is real time: use a 1 s window for the expiry leg
    const store = t.app.modules.rateLimit.service.store;
    const key = `pg-contract-${Math.random()}`;
    expect((await store.hit(key, 1000, 1)).count).toBe(1);
    expect((await store.hit(key, 1000, 1)).count).toBe(2);
    expect((await store.hit(key, 1000, 5)).count).toBe(7);
    expect((await store.hit(`${key}-x`, 1000, 1)).count).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await store.hit(key, 1000, 1)).count).toBe(1);
    // and the generic part of the contract, on a 60 s window
    await storeContract(() => store);
  });

  it('a concurrent burst counts every hit exactly once', async () => {
    const t = app();
    await t.app.ready();
    const store = t.app.modules.rateLimit.service.store;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => store.hit('burst', 60_000, 1)),
    );
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });

  it('refuses nonsense (window out of range) and is not reachable by the app role directly', async () => {
    const t = app();
    await t.app.ready();
    await expect(t.app.modules.rateLimit.service.store.hit('k', 5, 1)).rejects.toThrow();
    const { rows } = await owner.query<{ s: boolean; i: boolean }>(
      `SELECT has_table_privilege('lms_app', 'lms.rate_limit_counters', 'SELECT') AS s,
              has_table_privilege('lms_app', 'lms.rate_limit_counters', 'INSERT') AS i`,
    );
    expect(rows[0]).toEqual({ s: false, i: false });
  });

  it('the purge removes windows that ended more than a minute ago and nothing else', async () => {
    const t = app();
    await t.app.ready();
    await owner.query(
      `INSERT INTO lms.rate_limit_counters (key, hits, window_start, window_ms)
       VALUES ('old', 5, now() - interval '10 minutes', 60000), ('live', 5, now(), 60000)`,
    );
    expect(await t.app.modules.rateLimit.service.purge()).toBe(1);
    const left = await owner.query('SELECT key FROM lms.rate_limit_counters');
    expect(left.rows.map((r) => r.key)).toEqual(['live']);
  });
});

describe('limits hold across API instances', () => {
  it('login: the per-address limit counts the attempts of BOTH instances', async () => {
    const env = { RATE_LIMIT_LOGIN_PER_IP: '4', RATE_LIMIT_LOGIN_PER_EMAIL: '1000' };
    const one = app(env);
    const two = app(env);
    await one.app.ready();
    await two.app.ready();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = i % 2 === 0 ? one : two;
      codes.push(
        (await new TestClient(t, A.host).login(`x${i}@rls-a.test`, 'whatever pass')).statusCode,
      );
    }
    // each instance alone saw only 3 attempts (under its limit of 4): a per-instance limiter would have admitted all six
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes.slice(4)).toEqual([429, 429]);
  });

  it('login: the per-email limit is shared too, and the shared table never holds the address', async () => {
    const env = { RATE_LIMIT_LOGIN_PER_IP: '1000', RATE_LIMIT_LOGIN_PER_EMAIL: '2' };
    const one = app(env);
    const two = app(env);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = i % 2 === 0 ? one : two;
      codes.push(
        (await new TestClient(t, A.host).login('target@rls-a.test', 'x'.repeat(12))).statusCode,
      );
    }
    expect(codes).toEqual([401, 401, 429, 429]);
    const keys = await owner.query<{ key: string }>('SELECT key FROM lms.rate_limit_counters');
    expect(keys.rows.length).toBeGreaterThan(0);
    for (const r of keys.rows) expect(r.key).not.toContain('target@rls-a.test');
  });

  it('a route with config.strictRateLimit (CSP reports) is limited across instances', async () => {
    const one = app();
    const two = app();
    const codes: number[] = [];
    for (let i = 0; i < 64; i++) {
      const t = i % 2 === 0 ? one : two;
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/csp-report',
        headers: { 'content-type': 'application/csp-report', host: A.host },
        payload: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }),
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 60).every((c) => c === 204)).toBe(true);
    expect(codes.slice(60).every((c) => c === 429)).toBe(true);
  });
});

describe('round-trip cost (the endpoint budgets are unchanged; the limiter has its own)', () => {
  it('a high-rate signed-in route costs the limiter NOTHING on a single request (local tier)', async () => {
    const t = app();
    await t.app.ready();
    const c = new TestClient(t, A.host);
    expect((await c.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    t.statements.reset();
    expect((await c.get('/auth/me')).statusCode).toBe(200);
    expect(t.statements.limiter).toHaveLength(0);
  });

  it('a strict route costs exactly ONE autocommit limiter statement per limiter key', async () => {
    const t = app({ RATE_LIMIT_LOGIN_PER_IP: '1000', RATE_LIMIT_LOGIN_PER_EMAIL: '1000' });
    await t.app.ready();
    t.statements.reset();
    // a successful sign-in: one for the address, one for the (hashed) email
    expect((await new TestClient(t, A.host).login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(
      200,
    );
    expect(t.statements.limiter).toHaveLength(2);
    t.statements.reset();
    // a refused one counts a third key: the failures of the address
    expect(
      (await new TestClient(t, A.host).login('nobody@rls-a.test', 'whatever pass')).statusCode,
    ).toBe(401);
    expect(t.statements.limiter).toHaveLength(3);
    t.statements.reset();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(204);
    expect(t.statements.limiter).toHaveLength(1);
    expect(t.statements.count).toBe(0); // nothing else touches the database
  });
});

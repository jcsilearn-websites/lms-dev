import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// SIGN-IN LIMITS (docs/system-design-review.md, follow-up P1): a college behind ONE address (a lab, a campus NAT) must be able to
// sign in, while guessing stays limited. Three limits, all on POST /auth/login:
//   attempts per address   generous (a lab of 200 within a minute)
//   failures per address   much stricter (password spraying from one address)
//   attempts per e-mail    strict, unchanged
// The limits under test are the SHIPPED DEFAULTS: the overrides the test harness sets for other suites are removed here.

let owner: pg.Pool;
let A: AuthFixture;
const apps: TestApp[] = [];
const LEARNERS = 200;
const WRONG = 'definitely-not-the-password';

/** An empty value means "not set": the schema default applies. */
const DEFAULTS = {
  RATE_LIMIT_MAX: '',
  RATE_LIMIT_LOGIN_PER_IP: '',
  RATE_LIMIT_LOGIN_PER_EMAIL: '',
  RATE_LIMIT_LOGIN_FAILURES_PER_IP: '',
  RATE_LIMIT_AUTH_PER_IP: '',
};

const app = (env: Record<string, string> = {}) => {
  const t = makeApp({ env: { ...DEFAULTS, ...env } });
  apps.push(t);
  return t;
};
const learner = (n: number) => `lab-learner-${n}@signin-a.test`;
const signIn = (t: TestApp, email: string, password: string, forwarded?: string) =>
  new TestClient(t, A.host).post(
    '/auth/login',
    { email, password },
    forwarded ? { headers: { 'x-forwarded-for': forwarded } } : {},
  );

/** `count` sign-ins, `width` at a time (an argon2 queue refuses an unbounded burst with 503, which is not a rate limit). */
async function inWaves<T>(count: number, width: number, run: (n: number) => Promise<T>) {
  const results: T[] = [];
  for (let from = 0; from < count; from += width) {
    const wave = Array.from({ length: Math.min(width, count - from) }, (_, i) => run(from + i));
    results.push(...(await Promise.all(wave)));
  }
  return results;
}

beforeAll(async () => {
  owner = testOwnerPool(4);
  A = await createAuthFixture(owner, 'signin-a');
  // 200 learners with the member's password hash: what a real sign-in costs, without 200 hashes in the set-up
  const ids = Array.from({ length: LEARNERS }, () => newId());
  await owner.query(
    `INSERT INTO lms.users (id, email, display_name)
     SELECT u.id, 'lab-learner-' || (u.n - 1) || '@signin-a.test', 'Lab ' || u.n
       FROM unnest($1::uuid[]) WITH ORDINALITY AS u (id, n)`,
    [ids],
  );
  await owner.query(
    `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role)
     SELECT lms.uuid_v7(), $2, u.id, 'member' FROM unnest($1::uuid[]) AS u (id)`,
    [ids, A.tenantId],
  );
  await owner.query(
    `INSERT INTO lms.user_credentials (user_id, password_hash)
     SELECT u.id, c.password_hash FROM unnest($1::uuid[]) AS u (id)
      CROSS JOIN (SELECT password_hash FROM lms.user_credentials WHERE user_id = $2) c`,
    [ids, A.memberUserId],
  );
});
beforeEach(async () => {
  await owner.query('TRUNCATE lms.rate_limit_counters');
});
afterAll(async () => {
  for (const t of apps) await t.close();
  await owner.end();
});

describe('a lab behind one address', () => {
  it('200 learners sign in within a minute, one in five mistyping once, with no 429', async () => {
    const t = app();
    await t.app.ready();
    const started = Date.now();
    const statuses = await inWaves(LEARNERS, 20, async (n) => {
      const seen: number[] = [];
      if (n % 5 === 0) seen.push((await signIn(t, learner(n), WRONG)).statusCode);
      seen.push((await signIn(t, learner(n), TEST_PASSWORD)).statusCode);
      return seen;
    });
    expect(Date.now() - started).toBeLessThan(60_000);
    const all = statuses.flat();
    expect(all.filter((s) => s === 429)).toEqual([]);
    expect(all.filter((s) => s === 200)).toHaveLength(LEARNERS);
    expect(all.filter((s) => s === 401)).toHaveLength(LEARNERS / 5);
  }, 90_000);
});

describe('guessing', () => {
  it('11 wrong guesses at one e-mail within a minute are limited', async () => {
    const t = app();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await signIn(t, learner(1), WRONG)).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429, 429, 429, 429]);
  });

  it('wrong guesses at MANY e-mails from one address stop at 60; then even a right password waits', async () => {
    const t = app();
    const codes = await inWaves(
      60,
      10,
      async (n) => (await signIn(t, learner(n), WRONG)).statusCode,
    );
    expect(codes.filter((c) => c === 401)).toHaveLength(60);
    const refused = await signIn(t, learner(100), TEST_PASSWORD);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('successful sign-ins never count as failures', async () => {
    const t = app({ RATE_LIMIT_LOGIN_FAILURES_PER_IP: '3' });
    for (let n = 0; n < 8; n++) {
      expect((await signIn(t, learner(n), TEST_PASSWORD)).statusCode).toBe(200);
    }
  });

  it('the failure count is shared by every API instance', async () => {
    const env = { RATE_LIMIT_LOGIN_FAILURES_PER_IP: '4', RATE_LIMIT_STORE: 'postgres' };
    const one = app(env);
    const two = app(env);
    for (let i = 0; i < 4; i++) {
      expect((await signIn(i % 2 ? two : one, learner(i), WRONG)).statusCode).toBe(401);
    }
    // the instance that recorded the fourth failure knows at once; the other one learns from the shared count with its own
    expect((await signIn(two, learner(10), TEST_PASSWORD)).statusCode).toBe(429);
    expect((await signIn(one, learner(11), WRONG)).statusCode).toBe(401);
    expect((await signIn(one, learner(12), TEST_PASSWORD)).statusCode).toBe(429);
  });

  it('an invented X-Forwarded-For escapes neither limit', async () => {
    const t = app({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1' });
    const from = (n: number, real = '203.0.113.7') => `198.51.100.${n % 250}, ${real}`;
    const codes = await inWaves(
      60,
      10,
      async (n) => (await signIn(t, learner(n), WRONG, from(n))).statusCode,
    );
    expect(codes.filter((c) => c === 401)).toHaveLength(60);
    expect((await signIn(t, learner(100), TEST_PASSWORD, from(99))).statusCode).toBe(429);
    // another real address is not affected
    expect((await signIn(t, learner(100), TEST_PASSWORD, from(99, '203.0.113.8'))).statusCode).toBe(
      200,
    );
  });
});

describe('the other credential routes keep their strict per-address limit (as the MFA code routes did)', () => {
  it('MFA code checks stay at 10 a minute per address', async () => {
    const t = app();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (await new TestClient(t, A.host).post('/auth/mfa/verify', { code: '000000' })).statusCode,
      );
    }
    expect(codes.slice(0, 10).filter((c) => c === 429)).toEqual([]);
    expect(codes[10]).toBe(429);
  });
});

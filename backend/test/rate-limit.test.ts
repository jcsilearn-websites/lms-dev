import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type Person, person } from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Authenticated traffic is limited PER SESSION, never per address: a computer lab shares one public address. Anonymous
// traffic (login, probes) stays per address, and a forged session cookie does not buy a fresh budget.

let owner: pg.Pool;
let t: TestApp;
/** the same database behind an app with no practical limit: it signs people in (logins are anonymous, per address) */
let setup: TestApp;
let A: AuthFixture;
const LIMIT = 12;

beforeAll(async () => {
  owner = testOwnerPool();
  setup = makeApp();
  t = makeApp({ env: { RATE_LIMIT_MAX: String(LIMIT), RATE_LIMIT_WINDOW_MS: '60000' } });
  A = await createAuthFixture(owner, 'rl-a');
  await t.app.ready();
  await setup.app.ready();
});
afterAll(async () => {
  await t.close();
  await setup.close();
  await owner.end();
});

describe('rate limits per session', () => {
  it('60 users behind ONE address each get their own budget; one user over theirs does not slow the others', async () => {
    const users: Person[] = [];
    for (let i = 0; i < 60; i++) {
      const p = await person(owner, setup, A, `Lab${i}`);
      // the same session, now used against the app with the low limit
      const c = new TestClient(t, A.host);
      c.cookies = new Map(p.client.cookies);
      users.push({ ...p, client: c });
    }
    // every request below comes from the same address (inject uses 127.0.0.1)
    for (const u of users) {
      for (let k = 0; k < 8; k++) {
        const r = await u.client.get('/auth/me');
        expect(r.statusCode, `${u.email} request ${k}`).toBe(200);
      }
    }
    // 60 x 8 = 480 requests from one address: a per-address limit of 12 would have refused almost all of them
    const hog = users[0] as Person;
    let refused = 0;
    for (let k = 0; k < LIMIT + 5; k++)
      if ((await hog.client.get('/auth/me')).statusCode === 429) refused++;
    expect(refused).toBeGreaterThan(0);
    // a neighbour in the lab is not affected
    expect((await (users[1] as Person).client.get('/auth/me')).statusCode).toBe(200);
  });

  it('anonymous traffic is still limited per address', async () => {
    const anon = new TestClient(t, A.host);
    const codes: number[] = [];
    for (let k = 0; k < LIMIT + 5; k++) codes.push((await anon.get('/tenant/info')).statusCode);
    expect(codes).toContain(429);
  });

  it('a forged session cookie does not get a fresh budget for every request', async () => {
    const attacker = new TestClient(t, A.host);
    const codes: number[] = [];
    for (let k = 0; k < 120; k++) {
      // a new random cookie of the right shape each time: each would be its own "session bucket"
      const fake = Buffer.from(`forged-${k}-${Math.random()}`)
        .toString('base64url')
        .padEnd(43, 'x')
        .slice(0, 43);
      const r = await attacker.get('/auth/me', { headers: { cookie: `sid=${fake}` } });
      codes.push(r.statusCode);
    }
    // the first ones are plain 401s; after the per-address budget of unresolved sessions the answer is 429
    expect(codes).toContain(401);
    expect(codes).toContain(429);
  });
});

import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../src/core/password';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// PASSWORD-HASH QUEUE PRESSURE. argon2 runs 2 at a time per instance with a bounded wait queue. A sign-in that does not fit
// answers 503 `busy` with Retry-After (the page retries), and a refusal at the door costs none of the person's attempts.
// The queue here is the REAL one with no waiting room, and argon2 is held open by a gate: no timing, no sleeps.

let owner: pg.Pool;
let A: AuthFixture;
const apps: TestApp[] = [];

/** argon2 whose next calls wait until `release()`; `entered` resolves when both slots are inside. */
function gatedArgon2() {
  let open: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let inside = 0;
  let both: () => void = () => {};
  const entered = () =>
    new Promise<void>((resolve) => {
      both = resolve;
      if (inside >= 2) resolve();
    });
  const held = async () => {
    inside++;
    if (inside === 2) both();
    await gate;
    inside--;
  };
  return {
    engine: {
      hash: (async (...args: Parameters<typeof hash>) => {
        await held();
        return hash(...args);
      }) as typeof hash,
      verify: (async (...args: Parameters<typeof verify>) => {
        await held();
        return verify(...args);
      }) as typeof verify,
    },
    entered,
    close: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

/** An app whose two hashing slots are taken and that has no waiting room. */
async function saturated(env: Record<string, string> = {}) {
  const argon = gatedArgon2();
  const passwordHasher = createPasswordHasher({
    concurrency: 2,
    maxQueue: 0,
    argon2: argon.engine,
  });
  const t = makeApp({ env, passwordHasher });
  apps.push(t);
  await t.app.ready();
  argon.close();
  const holders = [passwordHasher.hash('holds slot one'), passwordHasher.hash('holds slot two')];
  await argon.entered();
  return {
    t,
    release: async () => {
      argon.release();
      await Promise.all(holders);
    },
  };
}

const signIn = (t: TestApp) =>
  new TestClient(t, A.host).post('/auth/login', { email: A.memberEmail, password: TEST_PASSWORD });

beforeAll(async () => {
  owner = testOwnerPool(2);
  A = await createAuthFixture(owner, 'busy-a');
});
afterAll(async () => {
  for (const t of apps) await t.close();
  await owner.end();
});

describe('a full password-hashing queue', () => {
  it('answers 503 `busy` with Retry-After, and signs in once a slot is free', async () => {
    const { t, release } = await saturated();
    const refused = await signIn(t);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('busy');
    expect(refused.headers['retry-after']).toBe('2');
    await release();
    expect((await signIn(t)).statusCode).toBe(200);
  });

  it('refusals at the door do not use up the attempts of the e-mail or of the address', async () => {
    const { t, release } = await saturated({
      RATE_LIMIT_LOGIN_PER_EMAIL: '2',
      RATE_LIMIT_LOGIN_PER_IP: '2',
    });
    for (let i = 0; i < 6; i++) expect((await signIn(t)).statusCode).toBe(503);
    await release();
    expect((await signIn(t)).statusCode).toBe(200);
  });
});

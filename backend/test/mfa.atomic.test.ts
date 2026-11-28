// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient } from './client';
import { errorCode, ok } from './courses-helpers';
import { type Clock, challenge, codeAt, createClock, type Enrolled, enrol } from './mfa-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// TWO-FACTOR SIGN-IN under concurrency and failure (step 14c part 1).
//   FAILURE INJECTION: a trigger raises on every audit insert; no state change of the second factor may survive without its row,
//   and nothing is checked that could not be recorded.
//   HELD-LOCK RACES (the technique of test/races.test.ts): a session of the test holds what the code under test needs, the test
//   waits until PostgreSQL says the code is BLOCKED, then commits.

let owner: pg.Pool;
let t: TestApp;
let off: TestApp;
let clock: Clock;
let colleges = 0;

const SWITCH = 'public.mfa_audit_failure_switch';
const dropInjection = async () => {
  await owner.query('DROP TRIGGER IF EXISTS zz_mfa_failure ON lms.audit_log');
  await owner.query('DROP FUNCTION IF EXISTS public.mfa_audit_failure_fn()');
  await owner.query(`DROP TABLE IF EXISTS ${SWITCH}`);
};
const arm = (on: boolean) => owner.query(`UPDATE ${SWITCH} SET failing = $1`, [on]);

beforeAll(async () => {
  owner = testOwnerPool(8);
  await dropInjection();
  await owner.query(`CREATE TABLE ${SWITCH} (failing boolean NOT NULL)`);
  await owner.query(`INSERT INTO ${SWITCH} VALUES (false)`);
  await owner.query(`
    CREATE FUNCTION public.mfa_audit_failure_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      IF (SELECT failing FROM public.mfa_audit_failure_switch) THEN
        RAISE EXCEPTION 'injected failure: the audit row could not be written' USING ERRCODE = 'XX000';
      END IF;
      RETURN NEW;
    END $$`);
  await owner.query(
    'CREATE TRIGGER zz_mfa_failure BEFORE INSERT ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.mfa_audit_failure_fn()',
  );
  clock = createClock();
  t = makeApp({ env: { MFA_ENFORCEMENT: 'required' }, now: () => clock.now() });
  off = makeApp({ now: () => clock.now() });
  await t.app.ready();
  await off.app.ready();
});
afterAll(async () => {
  await arm(false);
  await t.close();
  await off.close();
  await dropInjection();
  await owner.end();
});

const college = () => createAuthFixture(owner, `mfar-${++colleges}`);
const admin = (A: AuthFixture) => ({ host: A.host, email: A.adminEmail });
const value = async (sql: string, params: unknown[] = []) =>
  (await owner.query(sql, params)).rows[0];
const state = async (userId: string) => ({
  mfa: await value(
    'SELECT totp_failures, recovery_failures, last_used_step, secret_ciphertext FROM lms.user_mfa WHERE user_id = $1',
    [userId],
  ),
  unusedCodes: (
    await value(
      'SELECT count(*)::int AS n FROM lms.user_mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    )
  ).n,
  challenges: (
    await owner.query(
      'SELECT totp_attempts, recovery_attempts, used_at IS NOT NULL AS used FROM lms.auth_mfa_challenges WHERE user_id = $1 ORDER BY id',
      [userId],
    )
  ).rows,
  sessions: (
    await value(
      'SELECT count(*)::int AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
  ).n,
  openTokens: (
    await value(
      "SELECT count(*)::int AS n FROM lms.auth_tokens WHERE user_id = $1 AND purpose = 'mfa_enrol' AND used_at IS NULL",
      [userId],
    )
  ).n,
});

/** With the audit log refusing every row: the request fails and NOTHING of the person's state moves. */
async function failsAtomically(userId: string, call: () => Promise<{ statusCode: number }>) {
  const before = await state(userId);
  await arm(true);
  try {
    expect((await call()).statusCode).toBe(500);
  } finally {
    await arm(false);
  }
  expect(await state(userId)).toEqual(before);
}

describe('failure injection: no change without its audit row', () => {
  it('link request, enrol start, enrol confirm', async () => {
    const A = await college();
    // the password step: the queued mail goes with the audit row
    await failsAtomically(A.adminUserId, () =>
      new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD),
    );
    expect(
      (
        await value('SELECT count(*)::int AS n FROM lms.email_outbox WHERE user_id = $1', [
          A.adminUserId,
        ])
      ).n,
    ).toBe(0);

    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const token = await lastTokenFor(t, A.adminEmail);
    const browser = new TestClient(t, A.host);
    const body = { token, password: TEST_PASSWORD };
    await failsAtomically(A.adminUserId, () => browser.post('/auth/mfa/enrol/start', body));
    const started = ok(await browser.post('/auth/mfa/enrol/start', body));
    const confirm = () =>
      browser.post('/auth/mfa/enrol/confirm', { code: codeAt(started.secret, clock) });
    await failsAtomically(A.adminUserId, confirm);
    ok(await confirm());
    clock.tick();
  });

  it('challenge, TOTP attempt, TOTP accept, recovery code, lock report', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    await failsAtomically(who.userId, () =>
      new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD),
    );
    const c = await challenge(t, who);
    // the attempt cannot be recorded: it is not charged and the code is never looked at
    await failsAtomically(who.userId, () =>
      c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }),
    );
    await failsAtomically(who.userId, () =>
      c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }),
    );
    await failsAtomically(who.userId, () =>
      c.post('/auth/mfa/verify', { recoveryCode: 'ZZZZZ-ZZZZZ' }),
    );

    // the accept alone fails (the attempt before it is already recorded): no session, the step not used up
    const step = clock.step();
    const hash = (
      await value(
        'SELECT token_hash FROM lms.auth_mfa_challenges WHERE user_id = $1 AND used_at IS NULL ORDER BY id DESC LIMIT 1',
        [who.userId],
      )
    ).token_hash as Buffer;
    const before = await state(who.userId);
    await arm(true);
    await expect(
      owner.query(
        'SELECT * FROM lms.mfa_totp_accept($1, $2, $3, $4, $5, 600, 600, NULL, NULL, $6, $7)',
        [hash, A.tenantId, step, newId(), Buffer.alloc(32, 7), newId(), clock.now()],
      ),
    ).rejects.toThrow(/injected failure/);
    await arm(false);
    expect(await state(who.userId)).toEqual(before);

    await owner.query(
      'UPDATE lms.user_mfa SET totp_failures = 5, totp_locked_until = $2, totp_lock_reported = false WHERE user_id = $1',
      [who.userId, new Date(clock.now().getTime() + 60_000)],
    );
    await failsAtomically(who.userId, () =>
      c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }),
    );
    expect(
      (await value('SELECT totp_lock_reported FROM lms.user_mfa WHERE user_id = $1', [who.userId]))
        .totp_lock_reported,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ races
async function blocked(like: string, count = 1, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await owner.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [like],
    );
    if ((r.rowCount ?? 0) >= count) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`fewer than ${count} statement(s) like ${like} blocked on a lock`);
}

async function hold() {
  const c = await owner.connect();
  await c.query('BEGIN');
  let open = true;
  return {
    q: (sql: string, params: unknown[] = []) => c.query(sql, params),
    async commit() {
      if (!open) return;
      open = false;
      await c.query('COMMIT');
      c.release();
    },
  };
}

/** Both calls reach the database while the person's credential row is held, then run one after the other. */
async function simultaneously(
  who: Enrolled | { userId: string },
  like: string,
  calls: (() => PromiseLike<{ statusCode: number; json(): unknown }>)[],
) {
  const other = await hold();
  try {
    await other.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [who.userId]);
    const running = calls.map((call) => Promise.resolve(call()));
    await blocked(like, calls.length);
    await other.commit();
    return await Promise.all(running);
  } finally {
    await other.commit();
  }
}

const codes = (results: { statusCode: number }[]) => results.map((r) => r.statusCode).sort();

describe('held-lock races', () => {
  it('two verifications of ONE code (two challenges): exactly one session', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const a = await challenge(t, who);
    const b = await challenge(t, who);
    const code = codeAt(who.secret, clock);
    const before = (await state(who.userId)).sessions;
    const results = await simultaneously(who, '%mfa_totp_attempt%', [
      () => a.post('/auth/mfa/verify', { code }),
      () => b.post('/auth/mfa/verify', { code }),
    ]);
    expect(codes(results)).toEqual([200, 401]);
    expect(errorCode(results.find((r) => r.statusCode === 401) as never)).toBe('mfa_invalid_code');
    expect((await state(who.userId)).sessions).toBe(before + 1);
  });

  it('one recovery code used twice at once: exactly one session', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const a = await challenge(t, who);
    const b = await challenge(t, who);
    const before = (await state(who.userId)).sessions;
    const results = await simultaneously(
      who,
      '%mfa_recovery_use%',
      [a, b].map((c) => () => c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] })),
    );
    expect(codes(results)).toEqual([200, 401]);
    expect(await state(who.userId)).toMatchObject({ sessions: before + 1, unusedCodes: 9 });
  });

  it('one enrolment confirmed twice at once: one factor, one session, ten codes', async () => {
    const A = await college();
    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const token = await lastTokenFor(t, A.adminEmail);
    const browser = new TestClient(t, A.host);
    const started = ok(
      await browser.post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD }),
    );
    const cookie = { headers: { cookie: `mfa=${browser.cookie('mfa')}` } };
    const code = codeAt(started.secret, clock);
    const results = await simultaneously(
      { userId: A.adminUserId },
      '%mfa_enrol_attempt%',
      [0, 1].map(
        () => () => new TestClient(t, A.host).post('/auth/mfa/enrol/confirm', { code }, cookie),
      ),
    );
    expect(codes(results)).toEqual([200, 401]);
    expect(await state(A.adminUserId)).toMatchObject({ sessions: 1, unusedCodes: 10 });
    clock.tick();
  });

  it('a password sign-in that overlaps an enrolment gets no password-only session', async () => {
    const A = await college();
    const other = await hold();
    await other.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [
      A.adminUserId,
    ]);
    await other.q(
      "INSERT INTO lms.user_mfa (user_id, secret_ciphertext, secret_nonce, key_id, enabled_at, last_used_step) VALUES ($1, '\\x00', decode(repeat('00', 12), 'hex'), 'k', now(), 0)",
      [A.adminUserId],
    );
    // read before the commit: no factor yet. The session insert then waits on the credential row.
    const login = Promise.resolve(new TestClient(off, A.host).login(A.adminEmail, TEST_PASSWORD));
    await blocked('%auth_login_complete%');
    await other.commit();
    expect((await login).statusCode).toBe(401);
    expect((await state(A.adminUserId)).sessions).toBe(0);
  });

  it('a password reset that overlaps a verification: the challenge is gone, no session', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const c = await challenge(t, who);
    const before = (await state(who.userId)).sessions;
    const other = await hold();
    await other.q('UPDATE lms.user_credentials SET updated_at = now() WHERE user_id = $1', [
      who.userId,
    ]);
    await other.q('UPDATE lms.auth_mfa_challenges SET used_at = now() WHERE user_id = $1', [
      who.userId,
    ]);
    const verify = Promise.resolve(c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    await blocked('%mfa_totp_attempt%');
    await other.commit();
    expect(errorCode(await verify)).toBe('mfa_challenge_invalid');
    expect((await state(who.userId)).sessions).toBe(before);
  });

  it('account erasure that overlaps a verification: no deadlock, no session', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const c = await challenge(t, who);
    const other = await hold();
    // the erasure's lock order: credentials, then the user row
    await other.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [who.userId]);
    await other.q('SELECT 1 FROM lms.users WHERE id = $1 FOR UPDATE', [who.userId]);
    const verify = Promise.resolve(c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    await blocked('%mfa_totp_attempt%');
    // the trigger deletes challenges and the factor: a verification that had locked one of them first would deadlock here
    await other.q('UPDATE lms.users SET erased_at = now() WHERE id = $1', [who.userId]);
    await other.commit();
    expect(errorCode(await verify)).toBe('mfa_challenge_invalid');
    await owner.query('UPDATE lms.users SET erased_at = NULL WHERE id = $1', [who.userId]);
  });
});

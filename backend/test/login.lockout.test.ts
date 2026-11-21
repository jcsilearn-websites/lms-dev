import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// The lockout under a burst of parallel guesses, against the real database and the real argon2 (the model of the same rules, with a
// controllable hasher, is src/modules/auth/__tests__/auth.login-lockout.unit.test.ts).
//
// Rules pinned here: a failed login is counted BEFORE its 401 is returned (no background task: this file never calls background.drain()
// before it reads the database), the account locks exactly once, only LOGIN_MAX_ATTEMPTS failures are counted, and the right password
// sent after the lock never gets a session.

const MAX = 4;
let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool(4);
  t = makeApp({
    env: { LOGIN_MAX_ATTEMPTS: String(MAX), TENANT_CACHE_TTL_MS: '3600000' },
  });
  A = await createAuthFixture(owner, 'lockout-a');
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

async function state(email: string) {
  const r = await owner.query(
    `SELECT u.id, c.failed_attempts, c.locked_until,
            (SELECT count(*)::int FROM lms.audit_log a WHERE a.target_id = u.id::text AND a.action = 'auth.account_locked') AS lock_audits,
            (SELECT count(*)::int FROM lms.sessions s WHERE s.user_id = u.id) AS sessions
       FROM lms.users u JOIN lms.user_credentials c ON c.user_id = u.id WHERE u.email = $1`,
    [email],
  );
  return r.rows[0] as {
    id: string;
    failed_attempts: number;
    locked_until: Date | null;
    lock_audits: number;
    sessions: number;
  };
}

describe('login lockout: counted before the answer', () => {
  it('a wrong password is not answered while its failure is still being recorded', async () => {
    const f = await createAuthFixture(owner, 'lockout-b');
    const { id } = await state(f.memberEmail);
    // the test holds the credentials row: the failure statement (auth_record_login_failure) must wait for it
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [id]);
      let answered = false;
      const pending = new TestClient(t, f.host)
        .login(f.memberEmail, 'wrong password!!')
        .then((r) => {
          answered = true;
          return r;
        });
      const until = Date.now() + 10_000;
      for (;;) {
        const r = await owner.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%auth_login_failed%'`,
        );
        if ((r.rowCount ?? 0) > 0) break;
        if (Date.now() > until)
          throw new Error('the failure statement never waited on the row lock');
        await new Promise((res) => setTimeout(res, 25));
      }
      await new Promise((res) => setTimeout(res, 100));
      expect(answered, 'the 401 was sent before the failure was recorded').toBe(false);
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(401);
      expect((await state(f.memberEmail)).failed_attempts).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

describe('login lockout: parallel guesses', () => {
  it('N parallel wrong guesses lock the account exactly once, count exactly MAX, and the state is final when the answers arrive', async () => {
    const N = 12;
    const before = await state(A.memberEmail);
    expect(before.failed_attempts).toBe(0);

    const answers = await Promise.all(
      Array.from({ length: N }, () =>
        new TestClient(t, A.host).login(A.memberEmail, 'wrong password!!'),
      ),
    );
    expect(answers.every((r) => r.statusCode === 401)).toBe(true);

    // NO background.drain() here: every counted failure was recorded before its answer was sent
    const after = await state(A.memberEmail);
    expect(after.failed_attempts).toBe(MAX);
    expect(after.locked_until).not.toBeNull();
    expect(after.lock_audits).toBe(1);
    expect(after.sessions).toBe(0);
  });

  it('the right password is refused for as long as the lock holds, in parallel with more wrong guesses', async () => {
    const answers = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        new TestClient(t, A.host).login(A.memberEmail, 'still wrong!!!!'),
      ),
      new TestClient(t, A.host).login(A.memberEmail, TEST_PASSWORD),
    ]);
    expect(answers.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    const s = await state(A.memberEmail);
    expect(s.sessions).toBe(0);
    expect(s.failed_attempts).toBe(MAX); // attempts while locked are not counted
    expect(s.lock_audits).toBe(1);
  });

  it('a locked account answers a wrong password with the same status and body as an unlocked one (apart from the request id)', async () => {
    const strip = (body: string) => {
      const j = JSON.parse(body) as { error: { requestId?: string } };
      j.error.requestId = undefined;
      return j;
    };
    const f = await createAuthFixture(owner, 'lockout-c');
    const normal = await new TestClient(t, f.host).login(f.memberEmail, 'wrong password!!');
    const unknown = await new TestClient(t, f.host).login(
      'nobody@lockout-c.test',
      'wrong password!!',
    );
    for (let i = 0; i < MAX; i++)
      await new TestClient(t, f.host).login(f.memberEmail, 'wrong password!!');
    expect((await state(f.memberEmail)).locked_until).not.toBeNull();
    const locked = await new TestClient(t, f.host).login(f.memberEmail, 'wrong password!!');
    expect(normal.statusCode).toBe(401);
    expect(locked.statusCode).toBe(normal.statusCode);
    expect(strip(locked.body)).toEqual(strip(normal.body));
    expect(strip(unknown.body)).toEqual(strip(normal.body));
  });
});

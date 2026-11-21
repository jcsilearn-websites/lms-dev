// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { deliverEmails, lastTokenFor, TestClient } from './client';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// CLASS A: a change and its audit row are ONE transaction. CI found it twice (an invite; the Postgres-restart test): a lost connection
// between the two transactions left a change nobody could see in the audit log.
//
// FAILURE INJECTION: a trigger on both audit logs raises while a switch is on, i.e. "the connection died right after the change, before
// the audit row". If the change and the audit row are one transaction, the change is rolled back with the failed audit insert; if they are
// two, the change stays committed and the test sees it. The three flows that used to be two transactions (accept invite, unlock, reset
// request) each have a test; the rest of the table proves the fused statements keep the property (nothing here may change state when
// its audit row cannot be written). `test/audit-atomicity.unit.test.ts` is the static guard that keeps new code out of the pattern.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let platform: { userId: string; email: string };

const SWITCH = 'public.audit_failure_switch';

async function arm(on: boolean) {
  await owner.query(`UPDATE ${SWITCH} SET failing = $1`, [on]);
}

beforeAll(async () => {
  owner = testOwnerPool();
  // the switch lives in `public`: resetLms() truncates only schema lms. SECURITY DEFINER so that lms_app needs no grant on it.
  await owner.query(`DROP TRIGGER IF EXISTS zz_failure_injection ON lms.audit_log`);
  await owner.query(`DROP TRIGGER IF EXISTS zz_failure_injection ON lms.platform_audit_log`);
  await owner.query(`DROP FUNCTION IF EXISTS public.audit_failure_fn()`);
  await owner.query(`DROP TABLE IF EXISTS ${SWITCH}`);
  await owner.query(`CREATE TABLE ${SWITCH} (failing boolean NOT NULL)`);
  await owner.query(`INSERT INTO ${SWITCH} VALUES (false)`);
  await owner.query(`
    CREATE FUNCTION public.audit_failure_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      IF (SELECT failing FROM public.audit_failure_switch) THEN
        RAISE EXCEPTION 'injected failure: the audit row could not be written' USING ERRCODE = 'XX000';
      END IF;
      RETURN NEW;
    END $$`);
  for (const table of ['lms.audit_log', 'lms.platform_audit_log']) {
    await owner.query(
      `CREATE TRIGGER zz_failure_injection BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.audit_failure_fn()`,
    );
  }
  t = makeApp({ env: { LOGIN_MAX_ATTEMPTS: '3' } });
  A = await createAuthFixture(owner, 'atom-a');
  platform = await createPlatformAdmin(owner, 'root@atom.test');
  await t.app.ready();
});

afterAll(async () => {
  await arm(false);
  await t.close();
  await owner.query(`DROP TRIGGER IF EXISTS zz_failure_injection ON lms.audit_log`);
  await owner.query(`DROP TRIGGER IF EXISTS zz_failure_injection ON lms.platform_audit_log`);
  await owner.query(`DROP FUNCTION IF EXISTS public.audit_failure_fn()`);
  await owner.query(`DROP TABLE IF EXISTS ${SWITCH}`);
  await owner.end();
});

const client = () => new TestClient(t, A.host);
const adminClient = async () => {
  const c = client();
  expect((await c.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
  return c;
};
const count = async (sql: string, params: unknown[]) =>
  Number((await owner.query(sql, params)).rows[0]?.n);

describe('the injection works', () => {
  it('with the switch on, an audited call fails, and with it off the same call succeeds', async () => {
    const c = client();
    await arm(true);
    const failed = await c.login(A.memberEmail, TEST_PASSWORD);
    await arm(false);
    expect(failed.statusCode).toBe(500);
    expect((await c.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
  });
});

describe('the three flows that used to be two transactions', () => {
  it('accept invite: an audit failure leaves the membership pending and the token unused', async () => {
    const admin = await adminClient();
    const email = 'accept-atomic@atom-a.test';
    expect(
      (await admin.post('/auth/invites', { email, role: 'member', displayName: 'Atomic' }))
        .statusCode,
    ).toBe(201);
    const token = await lastTokenFor(t, email);
    const password = 'atomic chooses a passphrase';

    await arm(true);
    const failed = await client().post('/auth/invites/accept', { token, password });
    await arm(false);
    expect(failed.statusCode).toBe(500);
    // nothing of the acceptance survived: still pending, no credentials, the token can still be used
    const m = await owner.query(
      `SELECT m.status, (SELECT count(*) FROM lms.user_credentials c WHERE c.user_id = u.id)::int AS creds
         FROM lms.users u JOIN lms.tenant_memberships m ON m.user_id = u.id AND m.tenant_id = $1 WHERE u.email = $2`,
      [A.tenantId, email],
    );
    expect(m.rows[0]).toMatchObject({ status: 'pending', creds: 0 });

    const retry = await client().post('/auth/invites/accept', { token, password });
    expect(retry.statusCode).toBe(200);
    // and now the audit row exists, written by the same statement
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.invite_accepted'
            AND target_id = (SELECT id::text FROM lms.users WHERE email = $2)`,
        [A.tenantId, email],
      ),
    ).toBe(1);
  });

  it('unlock: an audit failure leaves the account locked', async () => {
    const admin = await adminClient();
    // lock the member: three wrong passwords (LOGIN_MAX_ATTEMPTS = 3); the failures are bookkept in the background
    for (let i = 0; i < 3; i++) await client().login(A.memberEmail, 'wrong password here');
    await t.app.modules.background.drain();
    const locked = await owner.query(
      'SELECT locked_until FROM lms.user_credentials WHERE user_id = $1',
      [A.memberUserId],
    );
    expect(locked.rows[0].locked_until).not.toBeNull();

    await arm(true);
    const failed = await admin.post(`/auth/members/${A.memberUserId}/unlock`);
    await arm(false);
    expect(failed.statusCode).toBe(500);
    const still = await owner.query(
      'SELECT locked_until, failed_attempts FROM lms.user_credentials WHERE user_id = $1',
      [A.memberUserId],
    );
    expect(still.rows[0].locked_until).not.toBeNull(); // the unlock did NOT happen without its audit row
    expect(still.rows[0].failed_attempts).toBeGreaterThan(0);

    expect((await admin.post(`/auth/members/${A.memberUserId}/unlock`)).statusCode).toBe(200);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.account_unlocked' AND target_id = $2`,
        [A.tenantId, A.memberUserId],
      ),
    ).toBe(1);
  });

  it('unlock on the admin host: the same, through platform_audit_log', async () => {
    const root = new TestClient(t, 'admin.localhost');
    expect((await root.login(platform.email, TEST_PASSWORD)).statusCode).toBe(200);
    await owner.query(
      `UPDATE lms.user_credentials SET failed_attempts = 4, locked_until = now() + interval '10 minutes' WHERE user_id = $1`,
      [A.memberUserId],
    );
    await arm(true);
    const failed = await root.post(`/auth/members/${A.memberUserId}/unlock`);
    await arm(false);
    expect(failed.statusCode).toBe(500);
    const still = await owner.query(
      'SELECT locked_until FROM lms.user_credentials WHERE user_id = $1',
      [A.memberUserId],
    );
    expect(still.rows[0].locked_until).not.toBeNull();
    expect((await root.post(`/auth/members/${A.memberUserId}/unlock`)).statusCode).toBe(200);
    await owner.query('UPDATE lms.user_credentials SET failed_attempts = 0, locked_until = NULL');
  });

  it('password reset request: an audit failure queues no email (no mail without its audit row)', async () => {
    const before = await count(
      `SELECT count(*) AS n FROM lms.email_outbox WHERE tenant_id = $1 AND template = 'password_reset'`,
      [A.tenantId],
    );
    await arm(true);
    // the request answers 202 whatever happens (nothing is revealed); the work is in the background
    expect(
      (await client().post('/auth/password/forgot', { email: A.memberEmail })).statusCode,
    ).toBe(202);
    await t.app.modules.background.drain();
    await arm(false);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.email_outbox WHERE tenant_id = $1 AND template = 'password_reset'`,
        [A.tenantId],
      ),
    ).toBe(before);

    // without the failure: the mail AND the audit row exist, together
    expect(
      (await client().post('/auth/password/forgot', { email: A.memberEmail })).statusCode,
    ).toBe(202);
    await deliverEmails(t);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.email_outbox WHERE tenant_id = $1 AND template = 'password_reset'`,
        [A.tenantId],
      ),
    ).toBe(before + 1);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.password_reset_requested' AND target_id = $2`,
        [A.tenantId, A.memberUserId],
      ),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('the fused statements keep the property: no audit row, no change', () => {
  it('create invite, change role, suspend, remove: the member and the invite stay as they were', async () => {
    const admin = await adminClient();
    const email = 'fused-atomic@atom-a.test';
    await arm(true);
    const invite = await admin.post('/auth/invites', { email, role: 'member' });
    await arm(false);
    expect(invite.statusCode).toBe(500);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id WHERE u.email = $1`,
        [email],
      ),
    ).toBe(0);

    for (const [method, url, body] of [
      ['PATCH', `/members/${A.memberUserId}/role`, { role: 'institution_admin' }],
      ['POST', `/members/${A.memberUserId}/suspend`, undefined],
      ['DELETE', `/members/${A.memberUserId}`, undefined],
    ] as const) {
      await arm(true);
      const r = await admin.request(method, url, body === undefined ? {} : { body });
      await arm(false);
      expect(r.statusCode, `${method} ${url}`).toBe(500);
      const m = await owner.query(
        'SELECT role, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [A.tenantId, A.memberUserId],
      );
      expect(m.rows[0], `${method} ${url}`).toEqual({ role: 'member', status: 'active' });
    }
  });

  it('branding, logout and change password change nothing when the audit row fails', async () => {
    const admin = await adminClient();
    await arm(true);
    const branding = await admin.patch('/tenant/branding', {
      displayName: 'Never Applied',
      primaryColor: '#112233',
    });
    await arm(false);
    expect(branding.statusCode).toBe(500);
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.tenant_settings WHERE tenant_id = $1 AND key = 'branding'
            AND value::text LIKE '%Never Applied%'`,
        [A.tenantId],
      ),
    ).toBe(0);

    // logout: the session survives a failed audit (the revocation and the audit are one statement)
    const c = client();
    expect((await c.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    await arm(true);
    const out = await c.post('/auth/logout');
    await arm(false);
    expect(out.statusCode).toBe(500);
    expect((await c.get('/auth/me')).statusCode).toBe(200);

    // change password: the old password still works
    await arm(true);
    const change = await c.post('/auth/password/change', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'a different long passphrase',
    });
    await arm(false);
    expect(change.statusCode).toBe(500);
    expect((await client().login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
  });
});

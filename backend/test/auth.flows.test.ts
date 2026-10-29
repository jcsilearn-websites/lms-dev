import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import { lastTokenFor, TestClient, waitForMail } from './client';
import { addMember } from './fixtures';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let platform: { userId: string; email: string };

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp({ env: { LOGIN_MAX_ATTEMPTS: '3' } });
  A = await createAuthFixture(owner, 'tenant-a');
  platform = await createPlatformAdmin(owner);
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
  await owner.end();
});

const client = () => new TestClient(t, A.host);
const adminClient = () => new TestClient(t, 'admin.localhost');

describe('login / me / logout', () => {
  it('logs a member in on the tenant host, sets a session cookie, and /auth/me reflects it', async () => {
    const c = client();
    const res = await c.login(A.memberEmail, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { email: A.memberEmail },
      tenant: { id: A.tenantId, slug: 'tenant-a' },
      role: 'member',
      isPlatformAdmin: false,
    });
    expect(c.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const me = await c.get('/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: A.memberUserId }, role: 'member' });
  });

  it('an institution admin gets the institution_admin role', async () => {
    const c = client();
    await c.login(A.adminEmail, TEST_PASSWORD);
    expect((await c.get('/auth/me')).json().role).toBe('institution_admin');
  });

  it('a platform admin logs in on the admin host (no tenant)', async () => {
    const c = adminClient();
    const res = await c.login(platform.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenant: null, role: null, isPlatformAdmin: true });
    expect((await c.get('/auth/me')).json().isPlatformAdmin).toBe(true);
  });

  it('logout revokes the session: the same cookie no longer works', async () => {
    const c = client();
    await c.login(A.memberEmail, TEST_PASSWORD);
    const token = c.sessionToken as string;
    const out = await c.post('/auth/logout');
    expect(out.statusCode).toBe(200);
    expect(c.sessionToken).toBeUndefined(); // cookie cleared
    const replay = new TestClient(t, A.host);
    replay.cookies.set('sid', token);
    expect((await replay.get('/auth/me')).statusCode).toBe(401);
  });

  it('/auth/me without a session is 401 with the standard error shape', async () => {
    const res = await client().get('/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'unauthenticated' });
  });
});

describe('sessions', () => {
  it('lists my sessions (marking the current one) and revokes another one of mine', async () => {
    const first = client();
    const second = client();
    await first.login(A.memberEmail, TEST_PASSWORD);
    await second.login(A.memberEmail, TEST_PASSWORD);

    const list = (await second.get('/auth/sessions')).json();
    expect(list.items.length).toBeGreaterThanOrEqual(2);
    expect(list.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.items.find((s: { current: boolean }) => !s.current);

    const del = await second.delete(`/auth/sessions/${other.id}`);
    expect(del.statusCode).toBe(200);
    const after = (await second.get('/auth/sessions')).json();
    expect(after.items.some((s: { id: string }) => s.id === other.id)).toBe(false);
  });

  it("cannot revoke another user's session (404)", async () => {
    const mine = client();
    const theirs = client();
    await mine.login(A.memberEmail, TEST_PASSWORD);
    await theirs.login(A.adminEmail, TEST_PASSWORD);
    const theirId = (await theirs.get('/auth/sessions')).json().items[0].id;
    const res = await mine.delete(`/auth/sessions/${theirId}`);
    expect(res.statusCode).toBe(404);
    expect((await theirs.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('password change', () => {
  it('changes the password, revokes the other sessions and keeps the current one', async () => {
    const u = await addMember(owner, A.tenantId, 'changer@tenant-a.test');
    const current = client();
    const other = client();
    await current.login(u.email, TEST_PASSWORD);
    await other.login(u.email, TEST_PASSWORD);

    const res = await current.post('/auth/password/change', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(res.statusCode).toBe(200);
    expect((await current.get('/auth/me')).statusCode).toBe(200);
    expect((await other.get('/auth/me')).statusCode).toBe(401);

    expect((await client().login(u.email, TEST_PASSWORD)).statusCode).toBe(401);
    expect((await client().login(u.email, 'a brand new passphrase')).statusCode).toBe(200);
  });

  it('rejects a wrong current password and weak new passwords', async () => {
    const u = await addMember(owner, A.tenantId, 'weak@tenant-a.test');
    const c = client();
    await c.login(u.email, TEST_PASSWORD);
    const wrong = await c.post('/auth/password/change', {
      currentPassword: 'not the password',
      newPassword: 'another long passphrase',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('invalid_current_password');
    for (const newPassword of ['short', 'password123', 'x'.repeat(129)]) {
      const res = await c.post('/auth/password/change', {
        currentPassword: TEST_PASSWORD,
        newPassword,
      });
      expect(res.statusCode, newPassword).toBe(400);
      expect(res.json().error.code).toBe('weak_password');
    }
  });
});

describe('password reset', () => {
  it('forgot always answers 202; an existing account gets a link, unknown emails get nothing', async () => {
    const u = await addMember(owner, A.tenantId, 'forgetful@tenant-a.test');
    const c = client();
    const known = await c.post('/auth/password/forgot', { email: u.email });
    const unknown = await c.post('/auth/password/forgot', { email: 'nobody@tenant-a.test' });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    await t.app.modules.background.drain();
    expect(t.mailer.sent.some((m) => m.to === u.email)).toBe(true);
    expect(t.mailer.sent.some((m) => m.to === 'nobody@tenant-a.test')).toBe(false);
  });

  it('reset sets the password, revokes all sessions, clears a lock and the token is single-use', async () => {
    const u = await addMember(owner, A.tenantId, 'resetter@tenant-a.test');
    const live = client();
    await live.login(u.email, TEST_PASSWORD);

    await client().post('/auth/password/forgot', { email: u.email });
    await waitForMail(t, u.email);
    const token = lastTokenFor(t, u.email);

    // the account is locked at the time of the reset
    await owner.query(
      "UPDATE lms.user_credentials SET failed_attempts = 5, locked_until = now() + interval '10 minutes' WHERE user_id = $1",
      [u.userId],
    );
    const reset = await client().post('/auth/password/reset', {
      token,
      newPassword: 'fresh passphrase 2024',
    });
    expect(reset.statusCode).toBe(200);
    expect((await live.get('/auth/me')).statusCode).toBe(401);
    expect((await client().login(u.email, 'fresh passphrase 2024')).statusCode).toBe(200);

    const reuse = await client().post('/auth/password/reset', {
      token,
      newPassword: 'yet another passphrase',
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('invalid_or_expired_token');
  });
});

describe('invites', () => {
  it('admin invites a new person; they accept with a password and can log in as a member', async () => {
    const admin = client();
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const invite = await admin.post('/auth/invites', {
      email: 'Newbie@Tenant-A.test ',
      role: 'member',
      displayName: 'Newbie',
    });
    expect(invite.statusCode).toBe(201);
    const token = lastTokenFor(t, 'newbie@tenant-a.test');

    // pending: cannot log in yet (no credentials at all)
    expect((await client().login('newbie@tenant-a.test', TEST_PASSWORD)).statusCode).toBe(401);

    const noPassword = await client().post('/auth/invites/accept', { token });
    expect(noPassword.statusCode).toBe(400);
    expect(noPassword.json().error.code).toBe('password_required');

    const accept = await client().post('/auth/invites/accept', {
      token,
      password: 'newbie chooses a passphrase',
    });
    expect(accept.statusCode).toBe(200);

    const c = client();
    const login = await c.login('newbie@tenant-a.test', 'newbie chooses a passphrase');
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ role: 'member', user: { displayName: 'Newbie' } });

    const again = await client().post('/auth/invites/accept', {
      token,
      password: 'whatever passphrase',
    });
    expect(again.statusCode).toBe(400); // single use
  });

  it('inviting an existing user from another tenant needs no password and does not reveal them', async () => {
    const other = await createAuthFixture(owner, 'tenant-c');
    const admin = client();
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const res = await admin.post('/auth/invites', {
      email: other.memberEmail,
      role: 'institution_admin',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: 'invited' });
    const token = lastTokenFor(t, other.memberEmail);
    expect((await client().post('/auth/invites/accept', { token })).statusCode).toBe(200);
    const c = client();
    expect((await c.login(other.memberEmail, TEST_PASSWORD)).json().role).toBe('institution_admin');
  });

  it('only an institution admin can invite', async () => {
    const member = client();
    await member.login(A.memberEmail, TEST_PASSWORD);
    const res = await member.post('/auth/invites', { email: 'x@tenant-a.test', role: 'member' });
    expect(res.statusCode).toBe(403);
  });
});

describe('lockout and unlock', () => {
  it('locks after the configured failures (audited), ignores correct passwords while locked, and an admin can unlock', async () => {
    const u = await addMember(owner, A.tenantId, 'locked@tenant-a.test');
    for (let i = 0; i < 3; i++) {
      const res = await client().login(u.email, 'wrong password here');
      expect(res.statusCode, res.body).toBe(401);
      await t.app.modules.background.drain();
    }
    const stillLocked = await client().login(u.email, TEST_PASSWORD);
    expect(stillLocked.statusCode).toBe(401); // generic, no hint

    const row = await owner.query(
      'SELECT failed_attempts, locked_until FROM lms.user_credentials WHERE user_id = $1',
      [u.userId],
    );
    expect(row.rows[0].failed_attempts).toBe(3);
    expect(new Date(row.rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());
    const audited = await owner.query(
      "SELECT 1 FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.account_locked' AND target_id = $2",
      [A.tenantId, u.userId],
    );
    expect(audited.rowCount).toBe(1);

    const admin = client();
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const unlock = await admin.post(`/auth/members/${u.userId}/unlock`);
    expect(unlock.statusCode).toBe(200);
    expect((await client().login(u.email, TEST_PASSWORD)).statusCode).toBe(200);
    const unlocked = await owner.query(
      "SELECT 1 FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.account_unlocked'",
      [A.tenantId],
    );
    expect(unlocked.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('a platform admin can unlock on the admin host (audited in platform_audit_log); members cannot unlock', async () => {
    const u = await addMember(owner, A.tenantId, 'locked2@tenant-a.test');
    await owner.query(
      "UPDATE lms.user_credentials SET failed_attempts = 4, locked_until = now() + interval '5 minutes' WHERE user_id = $1",
      [u.userId],
    );
    const member = client();
    await member.login(A.memberEmail, TEST_PASSWORD);
    expect((await member.post(`/auth/members/${u.userId}/unlock`)).statusCode).toBe(403);

    const root = adminClient();
    await root.login(platform.email, TEST_PASSWORD);
    expect((await root.post(`/auth/members/${u.userId}/unlock`)).statusCode).toBe(200);
    const audit = await owner.query(
      "SELECT 1 FROM lms.platform_audit_log WHERE action = 'auth.account_unlocked' AND target_id = $1",
      [u.userId],
    );
    expect(audit.rowCount).toBe(1);
    expect((await client().login(u.email, TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('an institution admin cannot unlock someone who is not a member of their tenant', async () => {
    const other = await createAuthFixture(owner, 'tenant-d');
    const admin = client();
    await admin.login(A.adminEmail, TEST_PASSWORD);
    const res = await admin.post(`/auth/members/${other.memberUserId}/unlock`);
    expect(res.statusCode).toBe(404);
  });
});

describe('audit trail', () => {
  it('records login success/failure and logout in the tenant audit_log', async () => {
    const u = await addMember(owner, A.tenantId, 'audited@tenant-a.test');
    const c = client();
    await client().login(u.email, 'wrong wrong wrong');
    await c.login(u.email, TEST_PASSWORD);
    await c.post('/auth/logout');
    await t.app.modules.background.drain();
    const { rows } = await owner.query<{ action: string }>(
      'SELECT action FROM lms.audit_log WHERE tenant_id = $1 AND actor_user_id = $2',
      [A.tenantId, u.userId],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['auth.login_failed', 'auth.login_succeeded', 'auth.logout']),
    );
  });
});

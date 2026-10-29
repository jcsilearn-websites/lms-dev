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
let A: AuthFixture;
let B: AuthFixture;
let platform: { userId: string; email: string };
const apps: TestApp[] = [];

/** Each test file section builds the app it needs (settings differ per scenario). */
function app(env: Record<string, string> = {}, logLevel = 'silent'): TestApp {
  const t = makeApp({ env, logLevel });
  apps.push(t);
  return t;
}

beforeAll(async () => {
  owner = testOwnerPool();
  A = await createAuthFixture(owner, 'sec-a');
  B = await createAuthFixture(owner, 'sec-b');
  platform = await createPlatformAdmin(owner, 'sec-root@platform.test');
});

afterAll(async () => {
  for (const t of apps) await t.close();
  await owner.end();
});

describe('credentials and timing', () => {
  it('wrong password and unknown email give byte-identical responses', async () => {
    const t = app();
    const wrong = await new TestClient(t, A.host).login(A.memberEmail, 'definitely not it');
    const unknown = await new TestClient(t, A.host).login('ghost@sec-a.test', 'definitely not it');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    const strip = (r: { json: () => { error: Record<string, unknown> } }) => {
      const { requestId: _omit, ...rest } = r.json().error;
      return rest;
    };
    expect(strip(unknown)).toEqual(strip(wrong));
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
  });

  it('a member of A cannot log in on B host, and gets the same generic error', async () => {
    const t = app();
    const res = await new TestClient(t, B.host).login(A.memberEmail, TEST_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  it('a pending (not yet accepted) member cannot log in, and only platform admins can use the admin host', async () => {
    const t = app();
    const pending = await addMember(owner, A.tenantId, 'pending@sec-a.test', { status: 'pending' });
    expect((await new TestClient(t, A.host).login(pending.email, TEST_PASSWORD)).statusCode).toBe(
      401,
    );
    expect(
      (await new TestClient(t, 'admin.localhost').login(A.memberEmail, TEST_PASSWORD)).statusCode,
    ).toBe(401);
    expect(
      (await new TestClient(t, 'admin.localhost').login(platform.email, TEST_PASSWORD)).statusCode,
    ).toBe(200);
  });

  it('platform admins are not members: they cannot log in on a tenant host', async () => {
    const t = app();
    const res = await new TestClient(t, A.host).login(platform.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(401);
  });
});

describe('lockout', () => {
  it('locks after N failures, is capped at the maximum, ignores attempts while locked, and a reset clears it', async () => {
    const t = app({
      LOGIN_MAX_ATTEMPTS: '3',
      LOCKOUT_BASE_SECONDS: '60',
      LOCKOUT_MAX_SECONDS: '900',
    });
    const u = await addMember(owner, A.tenantId, 'lockme@sec-a.test');
    for (let i = 0; i < 3; i++) {
      await new TestClient(t, A.host).login(u.email, 'wrong password');
      await t.app.modules.background.drain();
    }
    const locked = await owner.query<{ failed_attempts: number; locked_until: Date }>(
      'SELECT failed_attempts, locked_until FROM lms.user_credentials WHERE user_id = $1',
      [u.userId],
    );
    const seconds = (new Date(locked.rows[0]?.locked_until as Date).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThanOrEqual(61);

    // attempts while locked (even with the right password) are rejected and NOT counted
    expect((await new TestClient(t, A.host).login(u.email, TEST_PASSWORD)).statusCode).toBe(401);
    await new TestClient(t, A.host).login(u.email, 'wrong again');
    await t.app.modules.background.drain();
    const after = await owner.query(
      'SELECT failed_attempts FROM lms.user_credentials WHERE user_id = $1',
      [u.userId],
    );
    expect(after.rows[0].failed_attempts).toBe(3);

    // password reset clears the lock immediately
    await new TestClient(t, A.host).post('/auth/password/forgot', { email: u.email });
    await waitForMail(t, u.email);
    const reset = await new TestClient(t, A.host).post('/auth/password/reset', {
      token: lastTokenFor(t, u.email),
      newPassword: 'unlocked by reset 2024',
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (await new TestClient(t, A.host).login(u.email, 'unlocked by reset 2024')).statusCode,
    ).toBe(200);
  });

  it('the lock period doubles from the threshold but never exceeds the configured cap (15 minutes)', async () => {
    const t = app({
      LOGIN_MAX_ATTEMPTS: '3',
      LOCKOUT_BASE_SECONDS: '60',
      LOCKOUT_MAX_SECONDS: '900',
    });
    const u = await addMember(owner, A.tenantId, 'cap@sec-a.test');
    const fail = async () => {
      // clear the current lock so the next failure counts, keeping the attempt counter
      await owner.query('UPDATE lms.user_credentials SET locked_until = NULL WHERE user_id = $1', [
        u.userId,
      ]);
      await new TestClient(t, A.host).login(u.email, 'nope nope nope');
      await t.app.modules.background.drain();
      const r = await owner.query(
        'SELECT failed_attempts, locked_until FROM lms.user_credentials WHERE user_id = $1',
        [u.userId],
      );
      return {
        attempts: r.rows[0].failed_attempts as number,
        seconds: (new Date(r.rows[0].locked_until).getTime() - Date.now()) / 1000,
      };
    };
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await fail());
    // attempts 3,4,5 -> ~60s, ~120s, ~240s ...; ... 8 -> capped at 900s
    expect(results[2]?.seconds).toBeGreaterThan(30);
    expect(results[2]?.seconds).toBeLessThanOrEqual(61);
    expect(results[3]?.seconds).toBeGreaterThan(90);
    expect(results[3]?.seconds).toBeLessThanOrEqual(121);
    const last = results[7];
    expect(last?.attempts).toBe(8);
    expect(last?.seconds).toBeLessThanOrEqual(901);
    expect(last?.seconds).toBeGreaterThan(600);
  });
});

describe('rate limits', () => {
  it('limits login per IP and per email with the standard error shape', async () => {
    const perIp = app({ RATE_LIMIT_LOGIN_PER_IP: '3', RATE_LIMIT_LOGIN_PER_EMAIL: '1000' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await new TestClient(perIp, A.host).login(`ip-${i}@sec-a.test`, 'whatever pass');
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.json().error.code).toBe('rate_limited');
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);

    const perEmail = app({ RATE_LIMIT_LOGIN_PER_IP: '1000', RATE_LIMIT_LOGIN_PER_EMAIL: '2' });
    const same = [];
    for (let i = 0; i < 4; i++) {
      same.push(
        (await new TestClient(perEmail, A.host).login('target@sec-a.test', 'x'.repeat(12)))
          .statusCode,
      );
    }
    expect(same).toEqual([401, 401, 429, 429]);
    // a different email is not affected
    expect(
      (await new TestClient(perEmail, A.host).login('other@sec-a.test', 'x'.repeat(12))).statusCode,
    ).toBe(401);
  });

  it('also limits password-reset requests and invite acceptance', async () => {
    const t = app({ RATE_LIMIT_LOGIN_PER_IP: '2', RATE_LIMIT_LOGIN_PER_EMAIL: '1000' });
    const forgot = [];
    for (let i = 0; i < 3; i++) {
      forgot.push(
        (
          await new TestClient(t, A.host).post('/auth/password/forgot', {
            email: `f${i}@sec-a.test`,
          })
        ).statusCode,
      );
    }
    expect(forgot).toEqual([202, 202, 429]);
    const accept = [];
    for (let i = 0; i < 3; i++) {
      accept.push(
        (await new TestClient(t, A.host).post('/auth/invites/accept', { token: 'z'.repeat(43) }))
          .statusCode,
      );
    }
    expect(accept).toEqual([400, 400, 429]);
  });
});

describe('sessions: expiry, revocation, tenant binding', () => {
  it('idle-expired, absolute-expired and revoked sessions are rejected', async () => {
    const t = app();
    const cases: Array<[string, string]> = [
      ['idle', "idle_expires_at = now() - interval '1 second'"],
      ['absolute', "absolute_expires_at = now() - interval '1 second'"],
      ['revoked', 'revoked_at = now()'],
    ];
    for (const [name, set] of cases) {
      const c = new TestClient(t, A.host);
      await c.login(A.memberEmail, TEST_PASSWORD);
      expect((await c.get('/auth/me')).statusCode, `${name} (before)`).toBe(200);
      await owner.query(`UPDATE lms.sessions SET ${set} WHERE user_id = $1 AND tenant_id = $2`, [
        A.memberUserId,
        A.tenantId,
      ]);
      expect((await c.get('/auth/me')).statusCode, name).toBe(401);
    }
  });

  it('a session from tenant A used on tenant B host is rejected (and vice versa)', async () => {
    const t = app();
    const inA = new TestClient(t, A.host);
    await inA.login(A.memberEmail, TEST_PASSWORD);
    const token = inA.sessionToken as string;
    const onB = new TestClient(t, B.host);
    onB.cookies.set('sid', token);
    const res = await onB.get('/auth/me');
    expect(res.statusCode).toBe(401);
    // and a platform-less host mismatch: the same cookie on the admin host is also rejected
    const onAdmin = new TestClient(t, 'admin.localhost');
    onAdmin.cookies.set('sid', token);
    expect((await onAdmin.get('/auth/me')).statusCode).toBe(401);
    // still valid where it belongs
    expect((await inA.get('/auth/me')).statusCode).toBe(200);
  });

  it('a tenant admin session cannot be used on the admin host, nor a platform session on a tenant host', async () => {
    const t = app();
    const root = new TestClient(t, 'admin.localhost');
    await root.login(platform.email, TEST_PASSWORD);
    const onTenant = new TestClient(t, A.host);
    onTenant.cookies.set('sid', root.sessionToken as string);
    expect((await onTenant.get('/auth/me')).statusCode).toBe(401);
  });

  it('suspending a tenant takes effect on the very next request, even with a warm slug cache', async () => {
    const t = app({ TENANT_CACHE_TTL_MS: '600000' });
    const S = await createAuthFixture(owner, 'sec-suspend');
    const c = new TestClient(t, S.host);
    await c.login(S.memberEmail, TEST_PASSWORD);
    expect((await c.get('/auth/me')).statusCode).toBe(200); // cache is warm and says "active"

    await owner.query("UPDATE lms.tenants SET status = 'suspended' WHERE id = $1", [S.tenantId]);
    const next = await c.get('/auth/me');
    expect(next.statusCode).toBe(401); // session rejected by the database check, not by the cache
    // a new login is refused too, even though the slug cache still says "active"
    const login = await new TestClient(t, S.host).login(S.memberEmail, TEST_PASSWORD);
    expect(login.statusCode).toBe(404);
    expect(login.json().error.code).toBe('tenant_not_found');
    const sessions = await owner.query('SELECT 1 FROM lms.sessions WHERE tenant_id = $1', [
      S.tenantId,
    ]);
    expect(sessions.rowCount).toBe(1); // only the original one: no session was created
  });

  it('an unknown or suspended tenant answers 404 with the standard error shape', async () => {
    const t = app({ TENANT_CACHE_TTL_MS: '0' });
    const unknown = await new TestClient(t, 'no-such-tenant.localhost').get('/auth/me');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('tenant_not_found');
    const S = await createAuthFixture(owner, 'sec-gone');
    await owner.query("UPDATE lms.tenants SET status = 'suspended' WHERE id = $1", [S.tenantId]);
    const suspended = await new TestClient(t, S.host).login(S.memberEmail, TEST_PASSWORD);
    expect(suspended.statusCode).toBe(404);
    expect(suspended.json().error.code).toBe('tenant_not_found');
  });

  it("removing a membership kills that user's sessions in the tenant", async () => {
    const t = app();
    const u = await addMember(owner, A.tenantId, 'removed@sec-a.test');
    const c = new TestClient(t, A.host);
    await c.login(u.email, TEST_PASSWORD);
    expect((await c.get('/auth/me')).statusCode).toBe(200);
    await owner.query('DELETE FROM lms.tenant_memberships WHERE id = $1', [u.membershipId]);
    expect((await c.get('/auth/me')).statusCode).toBe(401);
  });

  it('the health probes and non-tenant hosts need no tenant', async () => {
    const t = app();
    const res = await t.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { host: 'whatever.example.org' },
    });
    expect(res.statusCode).toBe(200);
    const none = await new TestClient(t, 'localhost').get('/auth/me');
    expect(none.statusCode).toBe(401);
  });
});

describe('tokens', () => {
  it('expired, used, unknown and wrong-tenant tokens are rejected the same way', async () => {
    const t = app();
    const u = await addMember(owner, A.tenantId, 'tok@sec-a.test');
    const forgot = async () => {
      await new TestClient(t, A.host).post('/auth/password/forgot', { email: u.email });
      await t.app.modules.background.drain();
      return lastTokenFor(t, u.email);
    };
    const reset = (token: string) =>
      new TestClient(t, A.host).post('/auth/password/reset', {
        token,
        newPassword: 'a perfectly fine passphrase',
      });

    const expired = await forgot();
    await owner.query(
      "UPDATE lms.auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL",
      [u.userId],
    );
    expect((await reset(expired)).json().error.code).toBe('invalid_or_expired_token');

    const first = await forgot();
    const second = await forgot(); // issuing a new token invalidates the previous one
    expect((await reset(first)).statusCode).toBe(400);
    expect((await reset(second)).statusCode).toBe(200);
    expect((await reset(second)).statusCode).toBe(400); // single use
    expect((await reset('q'.repeat(43))).statusCode).toBe(400);
    expect((await reset('short')).statusCode).toBe(400); // schema-level
  });

  it('an invite token only works on the tenant it was issued for, expires, and is single-use', async () => {
    const t = app();
    const admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
    await admin.post('/auth/invites', { email: 'inv1@sec-a.test', role: 'member' });
    const token = lastTokenFor(t, 'inv1@sec-a.test');
    const pw = 'invite accepts a passphrase';
    expect(
      (await new TestClient(t, B.host).post('/auth/invites/accept', { token, password: pw }))
        .statusCode,
    ).toBe(400);

    await owner.query(
      "UPDATE lms.auth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = (SELECT token_hash FROM lms.auth_tokens ORDER BY created_at DESC LIMIT 1)",
    );
    expect(
      (await new TestClient(t, A.host).post('/auth/invites/accept', { token, password: pw }))
        .statusCode,
    ).toBe(400);

    await admin.post('/auth/invites', { email: 'inv1@sec-a.test', role: 'member' }); // re-invite
    const fresh = lastTokenFor(t, 'inv1@sec-a.test');
    expect(fresh).not.toBe(token);
    expect(
      (await new TestClient(t, A.host).post('/auth/invites/accept', { token: fresh, password: pw }))
        .statusCode,
    ).toBe(200);
    expect(
      (await new TestClient(t, A.host).post('/auth/invites/accept', { token: fresh, password: pw }))
        .statusCode,
    ).toBe(400);
  });

  it('invite acceptance on a suspended tenant fails', async () => {
    const t = app({ TENANT_CACHE_TTL_MS: '0' });
    const S = await createAuthFixture(owner, 'sec-inv-susp');
    const admin = new TestClient(t, S.host);
    await admin.login(S.adminEmail, TEST_PASSWORD);
    await admin.post('/auth/invites', { email: 'late@sec-inv-susp.test', role: 'member' });
    const token = lastTokenFor(t, 'late@sec-inv-susp.test');
    await owner.query("UPDATE lms.tenants SET status = 'suspended' WHERE id = $1", [S.tenantId]);
    const res = await new TestClient(t, S.host).post('/auth/invites/accept', {
      token,
      password: 'a good enough passphrase',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without a matching Origin and the X-Requested-With header', async () => {
    const t = app();
    const c = new TestClient(t, A.host);
    const body = { email: A.memberEmail, password: TEST_PASSWORD };
    const reject = async (headers: Record<string, string>, browser = true) => {
      const res = await c.post('/auth/login', body, { headers, browser });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json().error.code).toBe('csrf_rejected');
      expect(res.headers['set-cookie']).toBeUndefined();
    };
    await reject({}, false); // no Origin, no header
    await reject({ origin: `http://${A.host}` }, false); // Origin but no X-Requested-With
    await reject({ 'x-requested-with': 'lms' }, false); // header but no Origin
    await reject({ origin: 'http://evil.example.com' }); // cross-site Origin
    await reject({ origin: `http://${B.host}` }); // another tenant's Origin
    await reject({ origin: 'null' });
    await reject({ 'x-requested-with': 'XMLHttpRequest' }); // wrong header value
    await reject({ origin: 'not a url' });
  });

  it('accepts Referer when Origin is absent, and never blocks safe methods', async () => {
    const t = app();
    const c = new TestClient(t, A.host);
    const viaReferer = await c.post(
      '/auth/login',
      { email: A.memberEmail, password: TEST_PASSWORD },
      { browser: false, headers: { referer: `http://${A.host}/login`, 'x-requested-with': 'lms' } },
    );
    expect(viaReferer.statusCode).toBe(200);
    expect((await c.get('/auth/me', { browser: false })).statusCode).toBe(200);
  });

  it('applies to every state-changing method and endpoint with nothing exempt', async () => {
    const t = app();
    const c = new TestClient(t, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    for (const [method, url] of [
      ['POST', '/auth/logout'],
      ['POST', '/auth/password/change'],
      ['POST', '/auth/password/forgot'],
      ['POST', '/auth/password/reset'],
      ['POST', '/auth/invites'],
      ['POST', '/auth/invites/accept'],
      ['POST', `/auth/members/${A.memberUserId}/unlock`],
      ['DELETE', `/auth/sessions/${A.memberUserId}`],
      ['PUT', '/anything'],
      ['PATCH', '/anything'],
    ] as const) {
      const res = await c.request(method, url, {
        browser: false,
        body: method === 'DELETE' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await c.get('/auth/me')).statusCode).toBe(200); // the session survived all of that
  });
});

describe('cookies', () => {
  it('uses httpOnly, SameSite=Lax, Path=/ and no Domain; Secure + __Host- prefix when secure', async () => {
    const secure = app({ COOKIE_SECURE: 'true' });
    const res = await new TestClient(secure, A.host).login(A.memberEmail, TEST_PASSWORD);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/^__Host-sid=[A-Za-z0-9_-]{43};/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//i);
    expect(raw).not.toMatch(/Domain=/i);
    expect(raw).toMatch(/Expires=/i);

    const local = app({ COOKIE_SECURE: 'false' });
    const dev = String(
      (await new TestClient(local, A.host).login(A.memberEmail, TEST_PASSWORD)).headers[
        'set-cookie'
      ],
    );
    expect(dev).toMatch(/^sid=/);
    expect(dev).toMatch(/HttpOnly/i);
    expect(dev).not.toMatch(/Secure/i);
  });

  it('logout clears the cookie with the same attributes', async () => {
    const secure = app({ COOKIE_SECURE: 'true' });
    const c = new TestClient(secure, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    const out = await c.post('/auth/logout');
    const raw = String(out.headers['set-cookie']);
    expect(raw).toMatch(/^__Host-sid=;/);
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/Path=\//i);
  });

  it('only stores the SHA-256 of the session token in the database', async () => {
    const t = app();
    const c = new TestClient(t, A.host);
    await c.login(A.memberEmail, TEST_PASSWORD);
    const token = c.sessionToken as string;
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(token).digest();
    const rows = await owner.query('SELECT token_hash FROM lms.sessions WHERE token_hash = $1', [
      hash,
    ]);
    expect(rows.rowCount).toBe(1);
    const dump = await owner.query(
      "SELECT count(*)::int AS n FROM lms.sessions WHERE encode(token_hash, 'base64') LIKE '%' || $1 || '%'",
      [token],
    );
    expect(dump.rows[0].n).toBe(0);
  });
});

describe('secrets never leak', () => {
  it('no password, session token, reset/invite token or token hash appears in logs or response bodies', async () => {
    const t = app({ LOGIN_MAX_ATTEMPTS: '3' }, 'trace');
    const secretPassword = 'super secret passphrase for logs 91';
    const u = await addMember(owner, A.tenantId, 'logs@sec-a.test', { password: secretPassword });
    const seen: string[] = [];
    const bodies: string[] = [];
    const track = (res: { body: string }) => bodies.push(res.body);

    const c = new TestClient(t, A.host);
    track(await new TestClient(t, A.host).login(u.email, 'wrong password logged?'));
    track(await c.login(u.email, secretPassword));
    const session = c.sessionToken as string;
    seen.push(session);
    track(await c.get('/auth/me'));
    track(await c.get('/auth/sessions'));
    track(await c.post('/auth/password/forgot', { email: u.email }));
    await t.app.modules.background.drain();
    const reset = lastTokenFor(t, u.email);
    seen.push(reset);
    const newPassword = 'rotated passphrase for logs 92';
    track(
      await new TestClient(t, A.host).post('/auth/password/reset', { token: reset, newPassword }),
    );

    const admin = new TestClient(t, A.host);
    await admin.login(A.adminEmail, TEST_PASSWORD);
    track(await admin.post('/auth/invites', { email: 'logsinvite@sec-a.test', role: 'member' }));
    const invite = lastTokenFor(t, 'logsinvite@sec-a.test');
    seen.push(invite);
    track(
      await new TestClient(t, A.host).post('/auth/invites/accept', {
        token: invite,
        password: 'invitee passphrase for logs 93',
      }),
    );
    await t.app.modules.background.drain();

    const { createHash } = await import('node:crypto');
    for (const s of [session, reset, invite]) {
      const h = createHash('sha256').update(s).digest();
      seen.push(h.toString('hex'), h.toString('base64'), h.toString('base64url'));
    }
    seen.push(
      secretPassword,
      newPassword,
      'invitee passphrase for logs 93',
      TEST_PASSWORD,
      'wrong password logged?',
    );

    const logs = JSON.stringify(t.logs);
    expect(t.logs.length).toBeGreaterThan(10); // trace level: requests, responses, audit writes...
    for (const secret of seen) {
      expect(logs, `log contains ${secret.slice(0, 6)}...`).not.toContain(secret);
    }
    // response bodies never carry tokens or hashes (the session token only travels in Set-Cookie)
    for (const body of bodies) {
      for (const secret of seen) expect(body).not.toContain(secret);
    }
  });
});

describe('platform-admin audited access', () => {
  it('withPlatformAdminAccess writes the audit entry in the same transaction and refuses non-admins', async () => {
    const t = app();
    const audit = t.app.modules.audit.service;
    const result = await audit.withPlatformAdminAccess(
      { userId: platform.userId, isPlatformAdmin: true },
      A.tenantId,
      { action: 'platform.tenant_viewed', targetType: 'tenant', targetId: A.tenantId },
      async () => 'did the work',
    );
    expect(result).toBe('did the work');
    const row = await owner.query(
      "SELECT actor_user_id, metadata FROM lms.audit_log WHERE tenant_id = $1 AND action = 'platform.tenant_viewed'",
      [A.tenantId],
    );
    expect(row.rows[0].actor_user_id).toBe(platform.userId);
    expect(row.rows[0].metadata.platformAdmin).toBe(true);

    await expect(
      audit.withPlatformAdminAccess(
        { userId: A.memberUserId, isPlatformAdmin: false },
        A.tenantId,
        { action: 'x', targetType: 'tenant' },
        async () => 1,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    // if the work fails, the audit entry rolls back with it (never a partial record)
    await expect(
      audit.withPlatformAdminAccess(
        { userId: platform.userId, isPlatformAdmin: true },
        A.tenantId,
        { action: 'platform.failed_work', targetType: 'tenant' },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    const none = await owner.query(
      "SELECT 1 FROM lms.audit_log WHERE action = 'platform.failed_work'",
    );
    expect(none.rowCount).toBe(0);
  });
});

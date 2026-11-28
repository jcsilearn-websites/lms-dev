// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mfaKeyUsage, rekeyMfaSecrets } from '../src/cli/mfa-rekey';
import { createMfaCrypto } from '../src/core/mfa-crypto';
import { base32Decode } from '../src/core/totp';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { deliverEmails, lastTokenFor, TestClient } from './client';
import { errorCode, ok } from './courses-helpers';
import { type Clock, challenge, codeAt, createClock, enrol, wrongCode } from './mfa-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  setPassword,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// TWO-FACTOR SIGN-IN (step 14c part 1, docs/adr/0026-mfa.md): enrolment by emailed link, the challenge, TOTP with replay and
// drift, the two lockouts with their numbers, recovery codes, what ends sessions and challenges, isolation, budgets. Time is the
// app's INJECTED clock (explicit instants), never "now plus a sleep". Each describe uses its own college.

let owner: pg.Pool;
let t: TestApp; // enforcement on
let off: TestApp; // enforcement off, same database
let clock: Clock;

beforeAll(async () => {
  owner = testOwnerPool(4);
  clock = createClock();
  t = makeApp({ env: { MFA_ENFORCEMENT: 'required' }, now: () => clock.now() });
  off = makeApp({ now: () => clock.now() });
  await t.app.ready();
  await off.app.ready();
});
beforeEach(() => clock.reset());
afterAll(async () => {
  await t.close();
  await off.close();
  await owner.end();
});

let colleges = 0;
const college = () => createAuthFixture(owner, `mfa-${++colleges}`);
const admin = (A: AuthFixture) => ({ host: A.host, email: A.adminEmail });

const value = async (sql: string, params: unknown[] = []) =>
  (await owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) =>
  Number((await value(sql, params))?.n ?? 0);
const mfaRow = (userId: string) => value('SELECT * FROM lms.user_mfa WHERE user_id = $1', [userId]);
const audits = (userId: string, action: string) =>
  count(
    `SELECT (SELECT count(*) FROM lms.audit_log WHERE action = $2 AND actor_user_id = $1)
          + (SELECT count(*) FROM lms.platform_audit_log WHERE action = $2 AND actor_user_id = $1) AS n`,
    [userId, action],
  );
const liveSessions = (userId: string) =>
  count('SELECT count(*) AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
const mails = async (to: string, subject: RegExp) => {
  await deliverEmails(t);
  return t.mailer.sent.filter((m) => m.to === to && subject.test(m.subject)).length;
};

/** One wrong TOTP code on a fresh challenge-bearing browser. */
const wrongTotp = (c: TestClient, secret: string) =>
  c.post('/auth/mfa/verify', { code: wrongCode(secret, clock) });

describe('who is asked to enrol', () => {
  it('an institution admin and a platform admin get the link and NO session; a member signs in as before', async () => {
    const A = await college();
    const member = new TestClient(t, A.host);
    expect((await member.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    expect(ok(await member.get('/me/mfa'))).toEqual({
      required: false,
      enrolled: false,
      enrolledAt: null,
      recoveryCodesRemaining: 0,
    });

    const browser = new TestClient(t, A.host);
    const res = await browser.login(A.adminEmail, TEST_PASSWORD);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ step: 'enrol_email' });
    expect(browser.cookies.size).toBe(0);
    expect(await liveSessions(A.adminUserId)).toBe(0);
    expect(await audits(A.adminUserId, 'auth.mfa_enrol_link_requested')).toBe(1);

    const root = await createPlatformAdmin(owner, 'root-who@platform.test');
    const platform = await new TestClient(t, 'admin.localhost').login(root.email, TEST_PASSWORD);
    expect(platform.statusCode).toBe(202);
    expect(platform.json()).toEqual({ step: 'enrol_email' });
    await deliverEmails(t);
    const mail = t.mailer.sent.find((m) => m.to === root.email)!;
    expect(mail.text).toContain('http://admin.localhost');
    expect(mail.text).toMatch(/\/mfa\/enrol\?token=/);
  });

  it('a wrong password sends no link and answers like any failed sign-in', async () => {
    const A = await college();
    const res = await new TestClient(t, A.host).login(A.adminEmail, 'not the password at all');
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('invalid_credentials');
    expect(await mails(A.adminEmail, /two-step/i)).toBe(0);
  });
});

describe('enrolment', () => {
  it('link + password, then the first code: factor, 10 recovery codes, a verified session, audit, mail; nothing readable at rest', async () => {
    const A = await college();
    const old = new TestClient(off, A.host);
    expect((await old.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);

    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const token = await lastTokenFor(t, A.adminEmail);
    const browser = new TestClient(t, A.host);

    const bad = await browser.post('/auth/mfa/enrol/start', { token, password: 'wrong password!' });
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await value('SELECT failed_attempts FROM lms.user_credentials WHERE user_id = $1', [
          A.adminUserId,
        ])
      ).failed_attempts,
    ).toBe(1);

    const started = ok(
      await browser.post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD }),
    );
    expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.otpauthUri).toContain(`secret=${started.secret}`);
    expect(started.otpauthUri).toContain(encodeURIComponent(A.adminEmail));
    // nothing exists until the first code
    expect(await mfaRow(A.adminUserId)).toBeUndefined();

    const wrong = await browser.post('/auth/mfa/enrol/confirm', {
      code: wrongCode(started.secret, clock),
    });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('mfa_invalid_code');

    const done = ok(
      await browser.post('/auth/mfa/enrol/confirm', { code: codeAt(started.secret, clock) }),
    );
    expect(done.recoveryCodes).toHaveLength(10);
    expect(done.me.role).toBe('institution_admin');
    expect(browser.sessionToken).toBeDefined();
    expect(browser.cookie('mfa')).toBeUndefined();
    expect(ok(await browser.get('/me/mfa'))).toMatchObject({
      required: true,
      enrolled: true,
      recoveryCodesRemaining: 10,
    });
    // the session from before the factor is gone, the new one is marked verified
    expect((await old.get('/auth/me')).statusCode).toBe(401);
    expect(await liveSessions(A.adminUserId)).toBe(1);
    const session = await value(
      'SELECT mfa_verified_at FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [A.adminUserId],
    );
    expect(session.mfa_verified_at).toEqual(clock.now());
    for (const action of ['auth.mfa_enrol_started', 'auth.mfa_enrolled']) {
      expect(await audits(A.adminUserId, action), action).toBe(1);
    }
    expect(await mails(A.adminEmail, /two-step sign-in is now on/i)).toBe(1);

    // at rest: no plain secret and no recovery code anywhere
    const secret = base32Decode(started.secret);
    const row = await mfaRow(A.adminUserId);
    expect(Buffer.from(row.secret_ciphertext).includes(secret)).toBe(false);
    const dump = await owner.query(`
      SELECT metadata::text AS x FROM lms.audit_log
      UNION ALL SELECT metadata::text FROM lms.platform_audit_log
      UNION ALL SELECT params::text FROM lms.email_outbox
      UNION ALL SELECT payload::text FROM lms.jobs
      UNION ALL SELECT encode(code_hash, 'escape') || key_id FROM lms.user_mfa_recovery_codes`);
    const text = dump.rows.map((r) => r.x as string).join('\n');
    for (const needle of [
      started.secret,
      ...done.recoveryCodes,
      ...done.recoveryCodes.map((c: string) => c.replace('-', '')),
    ]) {
      expect(text.includes(needle)).toBe(false);
    }
  });

  it('the link works once, only on its own host, and for 30 minutes', async () => {
    const A = await college();
    const B = await college();
    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const token = await lastTokenFor(t, A.adminEmail);
    const start = (host: string) =>
      new TestClient(t, host).post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD });

    for (const host of [B.host, 'admin.localhost']) {
      const res = await start(host);
      expect(res.statusCode, host).toBe(400);
      expect(errorCode(res)).toBe('invalid_or_expired_token');
    }

    // exactly 30 minutes after the database stamped it
    const expires = (
      await value(
        "SELECT expires_at FROM lms.auth_tokens WHERE user_id = $1 AND purpose = 'mfa_enrol' AND used_at IS NULL",
        [A.adminUserId],
      )
    ).expires_at as Date;
    const before = clock.now();
    clock.advance(Math.ceil((expires.getTime() - before.getTime()) / 1000) + 1);
    expect((await start(A.host)).statusCode).toBe(400);
    clock.advance(-2);
    const browser = new TestClient(t, A.host);
    const started = ok(
      await browser.post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD }),
    );
    clock.advance(-Math.round((clock.now().getTime() - before.getTime()) / 1000));
    ok(await browser.post('/auth/mfa/enrol/confirm', { code: codeAt(started.secret, clock) }));
    clock.tick();
    expect((await start(A.host)).statusCode).toBe(400);
    expect(
      await count('SELECT count(*) AS n FROM lms.user_mfa WHERE user_id = $1', [A.adminUserId]),
    ).toBe(1);
  });

  it('a newer link voids the older, and the confirmation has 5 tries', async () => {
    const A = await college();
    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const first = await lastTokenFor(t, A.adminEmail);
    await new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD);
    const second = await lastTokenFor(t, A.adminEmail);
    expect(second).not.toBe(first);
    const browser = new TestClient(t, A.host);
    expect(
      (await browser.post('/auth/mfa/enrol/start', { token: first, password: TEST_PASSWORD }))
        .statusCode,
    ).toBe(400);
    const started = ok(
      await browser.post('/auth/mfa/enrol/start', { token: second, password: TEST_PASSWORD }),
    );
    for (let i = 0; i < 5; i++) {
      const res = await browser.post('/auth/mfa/enrol/confirm', {
        code: wrongCode(started.secret, clock),
      });
      expect(errorCode(res), `try ${i + 1}`).toBe('mfa_invalid_code');
    }
    const sixth = await browser.post('/auth/mfa/enrol/confirm', {
      code: codeAt(started.secret, clock),
    });
    expect(errorCode(sixth)).toBe('mfa_challenge_invalid');
    expect(await mfaRow(A.adminUserId)).toBeUndefined();
  });
});

describe('signing in with a code', () => {
  it('202 and a strict challenge cookie, then the code: drift of one step, never the same step twice', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));

    const browser = new TestClient(t, A.host);
    const first = await browser.login(A.adminEmail, TEST_PASSWORD);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ step: 'totp' });
    const cookie = first.cookies.find((c) => c.name === 'mfa')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', maxAge: 300, path: '/' });
    expect(browser.sessionToken).toBeUndefined();
    expect((await browser.get('/auth/me')).statusCode).toBe(401);

    clock.tick(2);
    const outside = await browser.post('/auth/mfa/verify', { code: codeAt(who.secret, clock, -2) });
    expect(errorCode(outside)).toBe('mfa_invalid_code');
    const me = ok(await browser.post('/auth/mfa/verify', { code: codeAt(who.secret, clock, -1) }));
    expect(me.user.email).toBe(A.adminEmail);
    expect(ok(await browser.get('/auth/me')).user.id).toBe(who.userId);
    // the challenge is used up
    expect(
      errorCode(await browser.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_challenge_invalid');

    // the very code that worked, on a new challenge: replayed
    const again = await challenge(t, who);
    const replay = await again.post('/auth/mfa/verify', { code: codeAt(who.secret, clock, -1) });
    expect(errorCode(replay)).toBe('mfa_invalid_code');
    // a later step works, the one drift step into the future too
    ok(await again.post('/auth/mfa/verify', { code: codeAt(who.secret, clock, 1) }));
    // ... after which the current step (earlier than the accepted one) is refused
    const third = await challenge(t, who);
    expect(
      errorCode(await third.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_invalid_code');
  });

  it('a challenge lives 5 minutes, counts only on its host, and allows 5 tries', async () => {
    const A = await college();
    const B = await college();
    const who = await enrol(t, owner, clock, admin(A));

    const late = await challenge(t, who);
    clock.advance(300);
    expect(
      errorCode(await late.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_challenge_invalid');
    const intime = await challenge(t, who);
    clock.advance(299);
    ok(await intime.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    clock.tick(2);

    const elsewhere = await challenge(t, who);
    const token = elsewhere.cookie('mfa')!;
    for (const host of [B.host, 'admin.localhost']) {
      const res = await new TestClient(t, host).post(
        '/auth/mfa/verify',
        { code: codeAt(who.secret, clock) },
        { headers: { cookie: `mfa=${token}` } },
      );
      expect(errorCode(res), host).toBe('mfa_challenge_invalid');
    }
    // refused elsewhere = untouched: it still works where it was issued
    for (let i = 0; i < 4; i++) {
      expect(errorCode(await wrongTotp(elsewhere, who.secret))).toBe('mfa_invalid_code');
    }
    ok(await elsewhere.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));

    clock.tick(2);
    const spent = await challenge(t, who);
    for (let i = 0; i < 5; i++) await wrongTotp(spent, who.secret);
    expect(
      errorCode(await spent.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_challenge_invalid');
  });

  it('a request needs exactly one of code and recoveryCode, and a challenge', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const c = await challenge(t, who);
    for (const body of [{}, { code: '123456', recoveryCode: 'ABCDE-FGHJK' }]) {
      expect(errorCode(await c.post('/auth/mfa/verify', body))).toBe('mfa_code_required');
    }
    const none = await new TestClient(t, A.host).post('/auth/mfa/verify', { code: '123456' });
    expect(errorCode(none)).toBe('mfa_challenge_invalid');
  });

  it('a membership suspended between the password and the code gets no session', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const c = await challenge(t, who);
    await owner.query(
      "UPDATE lms.tenant_memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2",
      [A.tenantId, A.memberUserId],
    );
    await owner.query(
      "UPDATE lms.tenant_memberships SET status = 'pending' WHERE tenant_id = $1 AND user_id = $2",
      [A.tenantId, who.userId],
    );
    const res = await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) });
    expect(errorCode(res)).toBe('mfa_challenge_invalid');
  });

  it('an enrolled person is challenged on EVERY host, also where they are only a member, and with enforcement off', async () => {
    const A = await college();
    const B = await college();
    const who = await enrol(t, owner, clock, admin(A));
    await owner.query(
      "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'active')",
      [newId(), B.tenantId, who.userId],
    );
    for (const [app, host] of [
      [t, B.host],
      [off, A.host],
      [off, B.host],
    ] as const) {
      const c = new TestClient(app, host);
      const res = await c.login(A.adminEmail, TEST_PASSWORD);
      expect(res.statusCode, host).toBe(202);
      expect(res.json()).toEqual({ step: 'totp' });
      clock.tick();
      ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    }
  });

  it('a platform admin signs in the same way on the admin host, audited in the platform log', async () => {
    const root = await createPlatformAdmin(owner, 'root-code@platform.test');
    const who = await enrol(t, owner, clock, { host: 'admin.localhost', email: root.email });
    const c = await challenge(t, who);
    const me = ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    expect(me).toMatchObject({ isPlatformAdmin: true, tenant: null });
    ok(await c.get('/platform/tenants'));
    expect(
      await count(
        `SELECT count(*) AS n FROM lms.platform_audit_log
          WHERE actor_user_id = $1 AND action = 'auth.login_succeeded' AND metadata ->> 'mfa' = 'totp'`,
        [root.userId],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM lms.audit_log WHERE actor_user_id = $1', [
        root.userId,
      ]),
    ).toBe(0);
  });
});

describe('enforcement and sessions', () => {
  it('an administrator session made without a factor does not count where enforcement is on; a member session does', async () => {
    const A = await college();
    const a = new TestClient(off, A.host);
    const m = new TestClient(off, A.host);
    expect((await a.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
    expect((await m.login(A.memberEmail, TEST_PASSWORD)).statusCode).toBe(200);
    const through = (c: TestClient) =>
      new TestClient(t, A.host).get('/auth/me', { headers: { cookie: `sid=${c.sessionToken}` } });
    expect((await through(a)).statusCode).toBe(401);
    expect((await through(m)).statusCode).toBe(200);
    expect((await a.get('/auth/me')).statusCode).toBe(200);
  });

  it('the one-off revocation ends administrator sessions only, and records how many', async () => {
    await owner.query('UPDATE lms.sessions SET revoked_at = now() WHERE revoked_at IS NULL');
    const A = await college();
    const root = await createPlatformAdmin(owner, 'root-revoke@platform.test');
    const sessions = [
      [A.host, A.adminEmail, 401],
      [A.host, A.memberEmail, 200],
      ['admin.localhost', root.email, 401],
    ] as const;
    const clients: [TestClient, number][] = [];
    for (const [host, email, after] of sessions) {
      const c = new TestClient(off, host);
      expect((await c.login(email, TEST_PASSWORD)).statusCode).toBe(200);
      clients.push([c, after]);
    }
    const audit = newId();
    expect((await value('SELECT lms.mfa_revoke_admin_sessions($1) AS n', [audit])).n).toBe(2);
    for (const [c, after] of clients) expect((await c.get('/auth/me')).statusCode).toBe(after);
    expect(
      (await value('SELECT action, metadata FROM lms.platform_audit_log WHERE id = $1', [audit]))
        .metadata,
    ).toEqual({ sessions: 2 });
    await expect(
      t.db.withoutTenant((exec) =>
        exec.execute(`select lms.mfa_revoke_admin_sessions('${newId()}')`),
      ),
    ).rejects.toThrow();
  });
});

describe('TOTP lockout: 5 wrong codes, then 60 s doubling to 15 minutes, from the 20th one try a day', () => {
  it('counts before answering, refuses while locked (uncounted), reports once, and does not block recovery codes', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const lockedFor = async () => {
      const r = await mfaRow(who.userId);
      return r.totp_locked_until
        ? (r.totp_locked_until.getTime() - clock.now().getTime()) / 1000
        : 0;
    };

    let c = await challenge(t, who);
    for (let i = 1; i <= 5; i++) {
      expect(errorCode(await wrongTotp(c, who.secret)), `wrong ${i}`).toBe('mfa_invalid_code');
      expect((await mfaRow(who.userId)).totp_failures).toBe(i);
      expect(await lockedFor()).toBe(i < 5 ? 0 : 60);
    }
    c = await challenge(t, who); // a new password step does not clear it
    const refused = await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) });
    expect(refused.statusCode).toBe(429);
    expect(errorCode(refused)).toBe('mfa_locked');
    expect(refused.headers['retry-after']).toBe('60');
    await wrongTotp(c, who.secret);
    expect((await mfaRow(who.userId)).totp_failures).toBe(5);
    expect(await audits(who.userId, 'auth.mfa_locked')).toBe(1);
    // five code attempts recorded (the enrolment's own confirmation is another method); the two refused ones are not
    const attempts = (method: string) =>
      count(
        "SELECT count(*) AS n FROM lms.audit_log WHERE actor_user_id = $1 AND action = 'auth.mfa_attempt' AND metadata ->> 'method' = $2",
        [who.userId, method],
      );
    expect(await attempts('totp')).toBe(5);
    expect(await attempts('enrol')).toBe(1);
    expect(await mails(who.email, /too many wrong sign-in codes/i)).toBe(1);

    clock.advance(59);
    expect((await wrongTotp(c, who.secret)).statusCode).toBe(429);
    clock.advance(1);

    // 6th to 10th wrong code: 120, 240, 480, then capped at 900
    for (const [nth, seconds] of [
      [6, 120],
      [7, 240],
      [8, 480],
      [9, 900],
      [10, 900],
    ] as const) {
      c = await challenge(t, who);
      expect(errorCode(await wrongTotp(c, who.secret)), `wrong ${nth}`).toBe('mfa_invalid_code');
      expect(await lockedFor(), `after wrong ${nth}`).toBe(seconds);
      clock.advance(seconds);
    }

    // the 19th still waits 15 minutes, the 20th a day
    await owner.query('UPDATE lms.user_mfa SET totp_failures = 18 WHERE user_id = $1', [
      who.userId,
    ]);
    c = await challenge(t, who);
    await wrongTotp(c, who.secret);
    expect(await lockedFor()).toBe(900);
    clock.advance(900);
    c = await challenge(t, who);
    await wrongTotp(c, who.secret);
    expect(await lockedFor()).toBe(86_400);
    clock.advance(86_399);
    c = await challenge(t, who);
    expect((await wrongTotp(c, who.secret)).statusCode).toBe(429);

    // a recovery code is not blocked by the locked TOTP counter, and clears it
    const me = ok(await c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }));
    expect(me.user.id).toBe(who.userId);
    expect(await mfaRow(who.userId)).toMatchObject({
      totp_failures: 0,
      totp_locked_until: null,
      recovery_failures: 0,
    });
    clock.tick(2);
    const fine = await challenge(t, who);
    ok(await fine.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
  });

  it('a right code resets the counter', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const c = await challenge(t, who);
    for (let i = 0; i < 4; i++) await wrongTotp(c, who.secret);
    ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    expect(await mfaRow(who.userId)).toMatchObject({ totp_failures: 0, totp_locked_until: null });
    expect(await mails(who.email, /too many wrong sign-in codes/i)).toBe(0);
  });
});

describe('recovery codes', () => {
  it('single use, typed loosely, counted down, mailed and audited', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const code = who.recoveryCodes[0]!;
    const c = await challenge(t, who);
    ok(
      await c.post('/auth/mfa/verify', {
        recoveryCode: ` ${code.toLowerCase().replace('-', ' ')} `,
      }),
    );
    expect(ok(await c.get('/me/mfa')).recoveryCodesRemaining).toBe(9);
    expect(await audits(who.userId, 'auth.mfa_recovery_used')).toBe(1);
    expect(await mails(who.email, /recovery code was used/i)).toBe(1);
    expect(t.mailer.sent.at(-1)!.text).toContain('9 recovery codes left');

    const again = await challenge(t, who);
    expect(errorCode(await again.post('/auth/mfa/verify', { recoveryCode: code }))).toBe(
      'mfa_invalid_code',
    );
    expect((await mfaRow(who.userId)).recovery_failures).toBe(1);
    ok(await again.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[1] }));
  });

  it('their own counter: 5 wrong lock for 60 s doubling to 15 minutes (no day-long tier), each counted before the answer; TOTP stays usable', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const wrong = (c: TestClient) => c.post('/auth/mfa/verify', { recoveryCode: 'ZZZZZ-ZZZZZ' });
    const lockedFor = async () => {
      const r = await mfaRow(who.userId);
      return r.recovery_locked_until
        ? (r.recovery_locked_until.getTime() - clock.now().getTime()) / 1000
        : 0;
    };

    let c = await challenge(t, who);
    for (let i = 1; i <= 5; i++) {
      expect(errorCode(await wrong(c)), `wrong ${i}`).toBe('mfa_invalid_code');
      expect((await mfaRow(who.userId)).recovery_failures).toBe(i);
    }
    expect(await lockedFor()).toBe(60);
    // the challenge's recovery tries are spent, its TOTP tries are not
    expect(errorCode(await wrong(c))).toBe('mfa_challenge_invalid');
    ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    expect((await mfaRow(who.userId)).recovery_failures).toBe(5);

    clock.tick();
    c = await challenge(t, who);
    const refused = await c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] });
    expect(errorCode(refused)).toBe('mfa_locked');
    expect(refused.headers['retry-after']).toBe(String(60 - 30));
    expect((await mfaRow(who.userId)).recovery_failures).toBe(5);

    await owner.query(
      'UPDATE lms.user_mfa SET recovery_failures = 60, recovery_locked_until = NULL WHERE user_id = $1',
      [who.userId],
    );
    c = await challenge(t, who);
    await wrong(c);
    expect(await lockedFor()).toBe(900);
    expect(await audits(who.userId, 'auth.mfa_failed')).toBe(6);
  });
});

describe('a new password', () => {
  it('a reset clears both counters and voids open challenges, and keeps the factor', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    const open = await challenge(t, who);
    await owner.query(
      'UPDATE lms.user_mfa SET totp_failures = 7, totp_locked_until = $2, recovery_failures = 5, recovery_locked_until = $2 WHERE user_id = $1',
      [who.userId, new Date(clock.now().getTime() + 3_600_000)],
    );
    const c = new TestClient(t, A.host);
    expect((await c.post('/auth/password/forgot', { email: who.email })).statusCode).toBe(202);
    const token = await lastTokenFor(t, who.email);
    const next = 'a completely different passphrase';
    ok(await c.post('/auth/password/reset', { token, newPassword: next }));

    expect(
      errorCode(await open.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_challenge_invalid');
    expect(await mfaRow(who.userId)).toMatchObject({
      totp_failures: 0,
      totp_locked_until: null,
      recovery_failures: 0,
      recovery_locked_until: null,
    });
    const res = await c.login(who.email, next);
    expect(res.json()).toEqual({ step: 'totp' });
    ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    await setPassword(owner, who.userId);
  });
});

describe('erasure and clean-up', () => {
  it('erasing the ACCOUNT removes factor, codes and challenges, and nothing can be added again', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    await challenge(t, who);
    await owner.query('UPDATE lms.users SET erased_at = now() WHERE id = $1', [who.userId]);
    for (const table of ['user_mfa', 'user_mfa_recovery_codes', 'auth_mfa_challenges']) {
      expect(
        await count(`SELECT count(*) AS n FROM lms.${table} WHERE user_id = $1`, [who.userId]),
        table,
      ).toBe(0);
    }
    await expect(
      owner.query(
        "INSERT INTO lms.user_mfa (user_id, secret_ciphertext, secret_nonce, key_id, enabled_at, last_used_step) VALUES ($1, '\\x00', decode(repeat('00', 12), 'hex'), 'k', now(), 0)",
        [who.userId],
      ),
    ).rejects.toThrow(/account was erased/);
    await owner.query('UPDATE lms.users SET erased_at = NULL WHERE id = $1', [who.userId]);
  });

  it('expired challenges are purged a day later', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    await challenge(t, who);
    const n = () =>
      count('SELECT count(*) AS n FROM lms.auth_mfa_challenges WHERE user_id = $1', [who.userId]);
    const before = await n();
    await t.app.modules.handlers['auth.purge_tokens']!.run({}, {} as never);
    expect(await n()).toBe(before);
    await owner.query(
      "UPDATE lms.auth_mfa_challenges SET expires_at = now() - interval '25 hours' WHERE user_id = $1",
      [who.userId],
    );
    await t.app.modules.handlers['auth.purge_tokens']!.run({}, {} as never);
    expect(await n()).toBe(0);
  });
});

describe('key rotation (pnpm mfa:rekey)', () => {
  it('moves every secret to the first key (audited), reports what each key still protects, and sign-in needs both until the codes are gone', async () => {
    const A = await college();
    const who = await enrol(t, owner, clock, admin(A));
    // the test app runs on the development key derived from the storage secret
    const dev = { kid: 'dev0', secret: 'test-only-signing-secret-0123456789abcdef' };
    const next = { kid: 'n1', secret: 'n'.repeat(40) };
    const client = await owner.connect();
    try {
      const enrolled = Number(
        (await client.query('SELECT count(*) AS n FROM lms.user_mfa')).rows[0].n,
      );
      expect(await rekeyMfaSecrets(client, createMfaCrypto([next, dev]))).toBe(enrolled);
      expect(await rekeyMfaSecrets(client, createMfaCrypto([next, dev]))).toBe(0);
      const usage = await mfaKeyUsage(client);
      expect(usage.find((u) => u.kid === 'n1')).toMatchObject({
        secrets: enrolled,
        unusedRecoveryCodes: 0,
      });
      // the recovery-code hashes cannot be re-keyed: the old key is still needed
      expect(usage.find((u) => u.kid === 'dev0')?.secrets).toBe(0);
      expect(usage.find((u) => u.kid === 'dev0')?.unusedRecoveryCodes).toBeGreaterThanOrEqual(10);
      expect((await mfaRow(who.userId)).key_id).toBe('n1');
      expect(
        await count(
          "SELECT count(*) AS n FROM lms.platform_audit_log WHERE action = 'platform.mfa_secrets_rekeyed'",
        ),
      ).toBe(1);

      const rotated = makeApp({
        env: { MFA_ENCRYPTION_KEYS: `n1:${next.secret},dev0:${dev.secret}` },
        now: () => clock.now(),
      });
      try {
        await rotated.app.ready();
        const c = await challenge(rotated, who);
        ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
        const r = await challenge(rotated, who);
        ok(await r.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }));
      } finally {
        await rotated.close();
      }
      // back, so that the other tests' rows are readable by their app again
      await rekeyMfaSecrets(client, createMfaCrypto([dev, next]));
    } finally {
      client.release();
    }
  });
});

describe('round-trip budgets', () => {
  const budget = async <T>(n: number, label: string, call: () => Promise<T>): Promise<T> => {
    await t.app.modules.background.drain();
    t.statements.reset();
    const result = await call();
    expect(t.statements.count, `${label}\n${t.statements.statements.join('\n')}`).toBe(n);
    return result;
  };

  it('every two-factor request', async () => {
    const A = await college();
    // warm the slug cache and the pool
    await new TestClient(t, A.host).login(A.memberEmail, TEST_PASSWORD);

    await budget(2, 'password step, must enrol', () =>
      new TestClient(t, A.host).login(A.adminEmail, TEST_PASSWORD),
    );
    const token = await lastTokenFor(t, A.adminEmail);
    const browser = new TestClient(t, A.host);
    const started = ok(
      await budget(2, 'enrol start', () =>
        browser.post('/auth/mfa/enrol/start', { token, password: TEST_PASSWORD }),
      ),
    );
    const done = ok(
      await budget(2, 'enrol confirm', () =>
        browser.post('/auth/mfa/enrol/confirm', { code: codeAt(started.secret, clock) }),
      ),
    );
    clock.tick();
    ok(await budget(2, 'GET /me/mfa', () => browser.get('/me/mfa')));

    const c = new TestClient(t, A.host);
    await budget(2, 'password step, challenge', () => c.login(A.adminEmail, TEST_PASSWORD));
    await budget(1, 'a wrong code', () => wrongTotp(c, started.secret));
    ok(
      await budget(2, 'verify', () =>
        c.post('/auth/mfa/verify', { code: codeAt(started.secret, clock) }),
      ),
    );
    const r = await challenge(t, admin(A));
    ok(
      await budget(1, 'recovery code', () =>
        r.post('/auth/mfa/verify', { recoveryCode: done.recoveryCodes[0] }),
      ),
    );
  });
});

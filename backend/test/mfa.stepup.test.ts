// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { deliverEmails, TestClient } from './client';
import { errorCode, ok } from './courses-helpers';
import {
  auditFailureInjection,
  blocked,
  type Clock,
  challenge,
  codeAt,
  createClock,
  type Enrolled,
  enrol,
  hold,
  wrongCode,
} from './mfa-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// STEP-UP AND THE PERSON'S OWN FACTOR (step 14c part 2, docs/adr/0026-mfa.md). Time is the app's INJECTED clock: the 10-minute
// window is checked at 9:59.999 and at 10:00 exactly.

let owner: pg.Pool;
let t: TestApp; // enforcement on
let off: TestApp; // enforcement off, same database
let clock: Clock;
let injection: Awaited<ReturnType<typeof auditFailureInjection>>;

const WINDOW_MS = 10 * 60_000;
const U = '00000000-0000-7000-8000-000000000000';

beforeAll(async () => {
  owner = testOwnerPool(8);
  injection = await auditFailureInjection(owner, 'stepup_failure');
  clock = createClock();
  t = makeApp({ env: { MFA_ENFORCEMENT: 'required' }, now: () => clock.now() });
  off = makeApp({ now: () => clock.now() });
  await t.app.ready();
  await off.app.ready();
});
beforeEach(() => clock.reset());
afterAll(async () => {
  await injection.arm(false);
  await t.close();
  await off.close();
  await injection.drop();
  await owner.end();
});

let colleges = 0;
const college = () => createAuthFixture(owner, `su-${++colleges}`);
const admin = (A: AuthFixture) => ({ host: A.host, email: A.adminEmail });
const value = async (sql: string, params: unknown[] = []) =>
  (await owner.query(sql, params)).rows[0];
const verifiedAt = async (userId: string) =>
  (
    await value(
      'SELECT max(mfa_verified_at) AS at FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
  ).at as Date;
/** Move the clock to an exact instant. */
const moveTo = (ms: number) => clock.advance((ms - clock.now().getTime()) / 1000);
/** Past the window of the last verification. */
const expireStepUp = () => clock.advance(WINDOW_MS / 1000 + 60);
const audits = async (userId: string, action: string) =>
  Number(
    (
      await value(
        `SELECT (SELECT count(*) FROM lms.audit_log WHERE action = $2 AND actor_user_id = $1)
              + (SELECT count(*) FROM lms.platform_audit_log WHERE action = $2 AND actor_user_id = $1) AS n`,
        [userId, action],
      )
    ).n,
  );
const factor = (userId: string) =>
  value(
    `SELECT m.secret_ciphertext, m.last_used_step, m.totp_failures, m.recovery_failures,
            (SELECT count(*)::int FROM lms.user_mfa_recovery_codes r WHERE r.user_id = m.user_id AND r.used_at IS NULL) AS codes,
            (SELECT array_agg(r.id ORDER BY r.id) FROM lms.user_mfa_recovery_codes r WHERE r.user_id = m.user_id) AS code_ids,
            (SELECT count(*)::int FROM lms.sessions s WHERE s.user_id = m.user_id AND s.revoked_at IS NULL) AS sessions,
            (SELECT max(s.mfa_verified_at) FROM lms.sessions s WHERE s.user_id = m.user_id) AS verified
       FROM lms.user_mfa m WHERE m.user_id = $1`,
    [userId],
  );
const stepUp = (c: TestClient, secret: string) =>
  c.post('/me/mfa/step-up', { code: codeAt(secret, clock) });

/** A sensitive action that touches nothing: the member does not exist, so an allowed call answers 404. */
const sensitive = (c: TestClient) => c.post(`/members/${U}/suspend`);

async function enrolledAdmin(): Promise<{ A: AuthFixture; who: Enrolled }> {
  const A = await college();
  return { A, who: await enrol(t, owner, clock, admin(A)) };
}

describe('the 10-minute window', () => {
  it('9:59.999 after the verification passes, 10:00 does not; a step-up opens it again', async () => {
    const { who } = await enrolledAdmin();
    const at = (await verifiedAt(who.userId)).getTime();
    moveTo(at + WINDOW_MS - 1);
    expect((await sensitive(who.browser)).statusCode).toBe(404);
    moveTo(at + WINDOW_MS);
    const refused = await sensitive(who.browser);
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('mfa_step_up_required');
    // reading is not a sensitive action
    ok(await who.browser.get('/members'));

    const done = ok(await stepUp(who.browser, who.secret));
    expect(done.validUntil).toBe(new Date(clock.now().getTime() + WINDOW_MS).toISOString());
    expect((await sensitive(who.browser)).statusCode).toBe(404);
    expect(await audits(who.userId, 'auth.mfa_step_up')).toBe(1);
  });

  it('is per session: stepping up in one browser does not open another', async () => {
    const { A, who } = await enrolledAdmin();
    const other = await challenge(t, who);
    ok(await other.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    clock.tick();
    expireStepUp();
    ok(await stepUp(other, who.secret));
    expect((await sensitive(other)).statusCode).toBe(404);
    expect(errorCode(await sensitive(who.browser))).toBe('mfa_step_up_required');
    expect(A.slug).toBeTruthy();
  });

  it('inviting asks for it only for an institution admin', async () => {
    const { who } = await enrolledAdmin();
    expireStepUp();
    const invite = (role: string, email: string) =>
      who.browser.post('/auth/invites', { email, role });
    expect((await invite('member', 'plain@su.test')).statusCode).toBe(201);
    expect(errorCode(await invite('institution_admin', 'second@su.test'))).toBe(
      'mfa_step_up_required',
    );
    ok(await stepUp(who.browser, who.secret));
    expect((await invite('institution_admin', 'second@su.test')).statusCode).toBe(201);
  });

  it('changing the own password asks an enrolled person; a person without a factor is not asked', async () => {
    const { A, who } = await enrolledAdmin();
    const member = new TestClient(t, A.host);
    ok(await member.login(A.memberEmail, TEST_PASSWORD));
    const body = { currentPassword: TEST_PASSWORD, newPassword: 'a-new-long-passphrase-77' };
    ok(await member.post('/auth/password/change', body));
    expireStepUp();
    expect(errorCode(await who.browser.post('/auth/password/change', body))).toBe(
      'mfa_step_up_required',
    );
  });

  it('with enforcement off an unenrolled admin is not asked, an enrolled person still is', async () => {
    const plain = await college();
    const unenrolled = new TestClient(off, plain.host);
    ok(await unenrolled.login(plain.adminEmail, TEST_PASSWORD));
    expect((await sensitive(unenrolled)).statusCode).toBe(404);

    const { who } = await enrolledAdmin();
    const viaOff = new TestClient(off, who.host);
    viaOff.cookies = new Map(who.browser.cookies);
    expireStepUp();
    expect(errorCode(await sensitive(viaOff))).toBe('mfa_step_up_required');
  });

  it('every listed route refuses a stale verification before doing anything', async () => {
    const root = await createPlatformAdmin(owner, 'stale-root@platform.test');
    const platform = await enrol(t, owner, clock, { host: 'admin.localhost', email: root.email });
    const { who } = await enrolledAdmin();
    expireStepUp();
    const college: [string, string][] = [
      ['PATCH', `/members/${U}/role`],
      ['POST', `/members/${U}/suspend`],
      ['POST', `/members/${U}/reactivate`],
      ['DELETE', `/members/${U}`],
      ['POST', `/auth/members/${U}/unlock`],
      ['POST', `/privacy/erasure-requests/${U}/approve`],
      ['POST', `/privacy/erasure-requests/${U}/reject`],
      ['POST', `/privacy/erasure-requests/${U}/cancel`],
      ['POST', `/offerings/${U}/gradebook/unlock`],
      ['POST', '/auth/password/change'],
      ['POST', '/me/mfa/replace/start'],
      ['POST', '/me/mfa/replace/confirm'],
      ['POST', '/me/mfa/recovery-codes'],
      ['POST', '/me/mfa/disable'],
    ];
    const adminHost: [string, string][] = [
      ['POST', '/platform/tenants'],
      ['PATCH', `/platform/tenants/${U}`],
      ['POST', `/platform/tenants/${U}/suspend`],
      ['POST', `/platform/tenants/${U}/reactivate`],
      ['POST', `/platform/tenants/${U}/admin-invite`],
      ['GET', `/platform/tenants/${U}/members`],
      ['PUT', `/platform/tenants/${U}/email-sender`],
      ['DELETE', `/platform/email/suppressions/${U}`],
      ['POST', '/platform/account-erasures'],
      ['POST', `/platform/account-erasures/${U}/approve`],
      ['POST', `/platform/account-erasures/${U}/reject`],
      ['POST', `/platform/account-erasures/${U}/cancel`],
      ['POST', '/platform/mfa-resets'],
      ['POST', `/platform/mfa-resets/${U}/approve`],
      ['POST', `/platform/mfa-resets/${U}/reject`],
      ['POST', `/platform/mfa-resets/${U}/cancel`],
    ];
    for (const [browser, list] of [
      [who.browser, college],
      [platform.browser, adminHost],
    ] as const) {
      for (const [method, url] of list) {
        const res = await browser.request(method, url);
        expect([url, res.statusCode, errorCode(res)]).toEqual([url, 403, 'mfa_step_up_required']);
      }
    }
  });
});

describe('the step-up itself', () => {
  it('a wrong or already used code is 400 (never a sign-out) and counts toward the lockout', async () => {
    const { who } = await enrolledAdmin();
    const used = codeAt(who.secret, clock);
    ok(await who.browser.post('/me/mfa/step-up', { code: used }));
    const replay = await who.browser.post('/me/mfa/step-up', { code: used });
    expect([replay.statusCode, errorCode(replay)]).toEqual([400, 'mfa_invalid_code']);
    ok(await who.browser.get('/auth/me'));
    // the replayed attempt was charged; four more wrong ones make five in a row, the next is locked
    clock.tick(2);
    for (let i = 0; i < 4; i++) {
      const res = await who.browser.post('/me/mfa/step-up', { code: wrongCode(who.secret, clock) });
      expect(res.statusCode).toBe(400);
    }
    const locked = await stepUp(who.browser, who.secret);
    expect([locked.statusCode, errorCode(locked)]).toEqual([429, 'mfa_locked']);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // a recovery code has its own counter
    ok(await who.browser.post('/me/mfa/step-up', { recoveryCode: who.recoveryCodes[0] }));
    expect((await factor(who.userId)).codes).toBe(9);
  });

  it('needs exactly one of the two, and a factor', async () => {
    const A = await college();
    const member = new TestClient(t, A.host);
    ok(await member.login(A.memberEmail, TEST_PASSWORD));
    expect(errorCode(await member.post('/me/mfa/step-up', {}))).toBe('mfa_code_required');
    const res = await member.post('/me/mfa/step-up', { code: '123456' });
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'mfa_not_enrolled']);
  });
});

describe('the own factor', () => {
  it('replace: the new app takes over, other sessions end, the old codes of the app stop working', async () => {
    const { who } = await enrolledAdmin();
    const other = await challenge(t, who);
    ok(await other.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    clock.tick();
    const started = ok(await who.browser.post('/me/mfa/replace/start'));
    expect(started.secret).not.toBe(who.secret);
    expect(started.otpauthUri).toContain(`secret=${started.secret}`);
    const wrong = await who.browser.post('/me/mfa/replace/confirm', {
      code: wrongCode(started.secret, clock),
    });
    expect([wrong.statusCode, errorCode(wrong)]).toEqual([400, 'mfa_invalid_code']);
    ok(await who.browser.post('/me/mfa/replace/confirm', { code: codeAt(started.secret, clock) }));
    clock.tick();
    expect((await other.get('/auth/me')).statusCode).toBe(401);
    ok(await who.browser.get('/auth/me'));
    // sign-in now needs the NEW app; the recovery codes stay
    const old = await challenge(t, who);
    expect(errorCode(await old.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }))).toBe(
      'mfa_invalid_code',
    );
    ok(await old.post('/auth/mfa/verify', { code: codeAt(started.secret, clock) }));
    expect((await factor(who.userId)).codes).toBe(10);
    expect(await audits(who.userId, 'auth.mfa_replaced')).toBe(1);
    await deliverEmails(t);
    expect(
      t.mailer.sent.filter(
        (m) => m.to === who.email && /authenticator app was replaced/.test(m.subject),
      ),
    ).toHaveLength(1);
  });

  it('new recovery codes: shown once, the earlier ones stop working', async () => {
    const { who } = await enrolledAdmin();
    const { recoveryCodes } = ok(await who.browser.post('/me/mfa/recovery-codes'));
    expect(recoveryCodes).toHaveLength(10);
    const c = await challenge(t, who);
    expect(
      errorCode(await c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] })),
    ).toBe('mfa_invalid_code');
    ok(await c.post('/auth/mfa/verify', { recoveryCode: recoveryCodes[0] }));
    expect(await audits(who.userId, 'auth.mfa_recovery_regenerated')).toBe(1);
  });

  it('disable: refused while the role needs the factor, allowed after it is gone', async () => {
    const { A, who } = await enrolledAdmin();
    expect(ok(await who.browser.get('/me/mfa')).canDisable).toBe(false);
    const refused = await who.browser.post('/me/mfa/disable');
    expect([refused.statusCode, errorCode(refused)]).toEqual([409, 'mfa_required']);
    // demoted: a second admin keeps the college from losing its last one
    await owner.query(
      "UPDATE lms.tenant_memberships SET role = 'institution_admin' WHERE tenant_id = $1 AND user_id = $2",
      [A.tenantId, A.memberUserId],
    );
    await owner.query(
      "UPDATE lms.tenant_memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2",
      [A.tenantId, who.userId],
    );
    expect(ok(await who.browser.get('/me/mfa')).canDisable).toBe(true);
    ok(await who.browser.post('/me/mfa/disable'));
    expect(await factor(who.userId)).toBeUndefined();
    expect(ok(await who.browser.get('/me/mfa'))).toMatchObject({ enrolled: false });
    expect((await new TestClient(t, A.host).login(who.email, TEST_PASSWORD)).statusCode).toBe(200);
    expect(await audits(who.userId, 'auth.mfa_disabled')).toBe(1);
  });
});

describe('failure injection: no change without its audit row', () => {
  it('step-up (code and recovery code), replace, new codes, disable', async () => {
    const { A, who } = await enrolledAdmin();
    const failsAtomically = async (call: () => PromiseLike<{ statusCode: number }>) => {
      const before = await factor(who.userId);
      await injection.arm(true);
      try {
        expect((await call()).statusCode).toBe(500);
      } finally {
        await injection.arm(false);
      }
      expect(await factor(who.userId)).toEqual(before);
    };
    await failsAtomically(() => stepUp(who.browser, who.secret));
    await failsAtomically(() =>
      who.browser.post('/me/mfa/step-up', { recoveryCode: who.recoveryCodes[0] }),
    );
    await failsAtomically(() => who.browser.post('/me/mfa/recovery-codes'));
    await failsAtomically(() => who.browser.post('/me/mfa/replace/start'));
    const started = ok(await who.browser.post('/me/mfa/replace/start'));
    await failsAtomically(() =>
      who.browser.post('/me/mfa/replace/confirm', { code: codeAt(started.secret, clock) }),
    );
    // the accept alone (the attempt before it already recorded): nothing moves
    const before = await factor(who.userId);
    const session = (
      await value('SELECT id FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL', [
        who.userId,
      ])
    ).id as string;
    await injection.arm(true);
    await expect(
      owner.query('SELECT lms.mfa_stepup_accept($1, $2, $3, $4, NULL, $5, $6)', [
        who.userId,
        session,
        A.tenantId,
        clock.step(),
        newId(),
        clock.now(),
      ]),
    ).rejects.toThrow(/injected failure/);
    await injection.arm(false);
    expect(await factor(who.userId)).toEqual(before);

    await owner.query("UPDATE lms.tenant_memberships SET status = 'removed' WHERE user_id = $1", [
      A.memberUserId,
    ]);
    await owner.query(
      "UPDATE lms.tenant_memberships SET role = 'institution_admin', status = 'active' WHERE user_id = $1",
      [A.memberUserId],
    );
    await owner.query("UPDATE lms.tenant_memberships SET role = 'member' WHERE user_id = $1", [
      who.userId,
    ]);
    await failsAtomically(() => who.browser.post('/me/mfa/disable'));
  });
});

describe('held-lock races', () => {
  it('two step-ups with ONE code: exactly one succeeds', async () => {
    const { who } = await enrolledAdmin();
    const other = await challenge(t, who);
    ok(await other.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    clock.tick();
    const code = codeAt(who.secret, clock);
    const holder = await hold(owner);
    try {
      await holder.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [
        who.userId,
      ]);
      const running = [who.browser, other].map((c) =>
        Promise.resolve(c.post('/me/mfa/step-up', { code })),
      );
      await blocked(owner, '%mfa_stepup_attempt%', 2);
      await holder.commit();
      const results = await Promise.all(running);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    } finally {
      await holder.commit();
    }
  });

  it('account erasure that overlaps a step-up: no deadlock, nothing verified', async () => {
    const { who } = await enrolledAdmin();
    const holder = await hold(owner);
    try {
      // the erasure's lock order: credentials, then the user row
      await holder.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [
        who.userId,
      ]);
      await holder.q('SELECT 1 FROM lms.users WHERE id = $1 FOR UPDATE', [who.userId]);
      const running = Promise.resolve(stepUp(who.browser, who.secret));
      await blocked(owner, '%mfa_stepup_attempt%');
      await holder.q('UPDATE lms.users SET erased_at = now() WHERE id = $1', [who.userId]);
      await holder.commit();
      const res = await running;
      expect([res.statusCode, errorCode(res)]).toEqual([409, 'mfa_not_enrolled']);
    } finally {
      await holder.commit();
      await owner.query('UPDATE lms.users SET erased_at = NULL WHERE id = $1', [who.userId]);
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

  it('every step-up and own-factor request', async () => {
    const { who } = await enrolledAdmin();
    const b = who.browser;
    ok(await b.get('/me/mfa'));
    ok(await budget(3, 'step-up with a code', async () => stepUp(b, who.secret)));
    clock.tick();
    await budget(2, 'step-up, wrong code', async () =>
      b.post('/me/mfa/step-up', { code: wrongCode(who.secret, clock) }),
    );
    ok(
      await budget(2, 'step-up with a recovery code', async () =>
        b.post('/me/mfa/step-up', { recoveryCode: who.recoveryCodes[0] }),
      ),
    );
    ok(await budget(2, 'new recovery codes', async () => b.post('/me/mfa/recovery-codes')));
    const started = ok(
      await budget(2, 'replace start', async () => b.post('/me/mfa/replace/start')),
    );
    ok(
      await budget(3, 'replace confirm', async () =>
        b.post('/me/mfa/replace/confirm', { code: codeAt(started.secret, clock) }),
      ),
    );
    // refused before any statement of its own: the session lookup only
    await budget(2, 'disable (refused)', async () => b.post('/me/mfa/disable'));
    expireStepUp();
    await budget(1, 'a route that asks for a step-up', async () => sensitive(b));
  });
});

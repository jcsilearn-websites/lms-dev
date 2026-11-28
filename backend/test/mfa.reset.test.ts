// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapPlatformAdmin } from '../src/cli/create-platform-admin';
import { breakGlassReset } from '../src/cli/mfa-reset';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { deliverEmails, lastTokenFor, TestClient, waitForMail } from './client';
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
} from './mfa-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// THE FOUR-EYES RESET of a lost second factor, the break glass and admin:create (step 14c part 2, docs/adr/0026-mfa.md).
// Time is the app's INJECTED clock: the 24 hours before execution and the 7 days to decide are checked to the millisecond.

let owner: pg.Pool;
let t: TestApp; // enforcement on (the people who have a factor)
let off: TestApp; // enforcement off: the platform administrators work without a factor of their own
let clock: Clock;
let injection: Awaited<ReturnType<typeof auditFailureInjection>>;
let admins: { client: TestClient; userId: string; email: string }[];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const U = '00000000-0000-7000-8000-000000000000';

beforeAll(async () => {
  owner = testOwnerPool(8);
  injection = await auditFailureInjection(owner, 'reset_failure');
  clock = createClock();
  t = makeApp({ env: { MFA_ENFORCEMENT: 'required' }, now: () => clock.now() });
  off = makeApp({ now: () => clock.now() });
  await t.app.ready();
  await off.app.ready();
  admins = [];
  for (const n of [1, 2, 3]) {
    const a = await createPlatformAdmin(owner, `reset-root${n}@platform.test`);
    const client = new TestClient(off, 'admin.localhost');
    ok(await client.login(a.email, TEST_PASSWORD));
    admins.push({ client, ...a });
  }
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
const college = () => createAuthFixture(owner, `rs-${++colleges}`);
const value = async (sql: string, params: unknown[] = []) =>
  (await owner.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) =>
  Number((await value(sql, params))?.n ?? 0);
const moveTo = (ms: number) => clock.advance((ms - clock.now().getTime()) / 1000);
const run = () => off.app.modules.handlers['mfa.reset_run']!.run({}, {} as never);

const file = (i: number, email: string) =>
  admins[i]!.client.post('/platform/mfa-resets', { email });
const decide = (i: number, id: string, action: 'approve' | 'reject' | 'cancel') =>
  admins[i]!.client.post(`/platform/mfa-resets/${id}/${action}`);
const request = (id: string) => value('SELECT * FROM lms.mfa_reset_requests WHERE id = $1', [id]);

/** An enrolled institution admin. */
async function subject(): Promise<{ A: AuthFixture; who: Enrolled }> {
  const A = await college();
  return { A, who: await enrol(t, owner, clock, { host: A.host, email: A.adminEmail }) };
}

async function approved(who: Enrolled): Promise<string> {
  const filed = ok(await file(0, who.email)).request;
  ok(await decide(1, filed.id, 'approve'));
  return filed.id;
}

const state = async (userId: string) => ({
  factor: await count('SELECT count(*) AS n FROM lms.user_mfa WHERE user_id = $1', [userId]),
  codes: await count('SELECT count(*) AS n FROM lms.user_mfa_recovery_codes WHERE user_id = $1', [
    userId,
  ]),
  challenges: await count('SELECT count(*) AS n FROM lms.auth_mfa_challenges WHERE user_id = $1', [
    userId,
  ]),
  sessions: await count(
    'SELECT count(*) AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  ),
  password: (
    await value('SELECT password_hash FROM lms.user_credentials WHERE user_id = $1', [userId])
  )?.password_hash as string,
  requests: (
    await owner.query(
      'SELECT status, reason FROM lms.mfa_reset_requests WHERE user_id = $1 ORDER BY id',
      [userId],
    )
  ).rows,
  outbox: await count('SELECT count(*) AS n FROM lms.email_outbox WHERE user_id = $1', [userId]),
});

const collegeAudits = (tenantId: string, userId: string, action: string) =>
  count(
    'SELECT count(*) AS n FROM lms.audit_log WHERE tenant_id = $1 AND target_id = $2 AND action = $3',
    [tenantId, userId, action],
  );
const platformAudits = (userId: string, action: string) =>
  count('SELECT count(*) AS n FROM lms.platform_audit_log WHERE target_id = $1 AND action = $2', [
    userId,
    action,
  ]);
const mails = async (to: string, subjectLine: RegExp) => {
  await deliverEmails(t);
  await deliverEmails(off);
  return [...t.mailer.sent, ...off.mailer.sent].filter(
    (m) => m.to === to && subjectLine.test(m.subject),
  ).length;
};

describe('filing and deciding', () => {
  it('platform administrators only; the person must exist, be somebody else and have a factor', async () => {
    const { A, who } = await subject();
    const tenantAdmin = who.browser;
    expect((await tenantAdmin.get('/platform/mfa-resets')).statusCode).toBe(403);
    expect(errorCode(await file(0, 'nobody@nowhere.test'))).toBe('account_not_found');
    expect(errorCode(await file(0, admins[0]!.email))).toBe('mfa_reset_self');
    expect(errorCode(await file(0, A.memberEmail))).toBe('mfa_not_enrolled');
    const accepted = await file(0, `  ${who.email.toUpperCase()} `);
    expect(accepted.statusCode).toBe(202);
    const filed = ok(accepted).request;
    expect(filed).toMatchObject({ status: 'pending_approval', executeAfter: null });
    expect(Date.parse(filed.expiresAt) - Date.parse(filed.requestedAt)).toBe(7 * DAY);
    expect(errorCode(await file(1, who.email))).toBe('mfa_reset_in_progress');
    const listed = ok(await admins[1]!.client.get('/platform/mfa-resets')).items[0];
    expect(listed).toMatchObject({
      id: filed.id,
      personEmail: who.email,
      requestedByName: 'Root',
      approvedByName: null,
      canApprove: true,
      canCancel: true,
    });
    expect(ok(await admins[0]!.client.get('/platform/mfa-resets')).items[0].canApprove).toBe(false);
    ok(await decide(0, filed.id, 'cancel'));
  });

  it('the filer, the approver and the person are three people: the service and the database say so', async () => {
    // the person is a platform administrator with a factor
    const target = await createPlatformAdmin(owner, 'reset-target@platform.test');
    const enrolled = await enrol(t, owner, clock, {
      host: 'admin.localhost',
      email: target.email,
    });
    const filed = ok(await file(0, target.email)).request;
    for (const action of ['approve', 'reject'] as const) {
      expect(errorCode(await decide(0, filed.id, action))).toBe('mfa_reset_self_approval');
    }
    // the person themselves, signed in on the admin host (their step-up is fresh from the enrolment)
    const self = await enrolled.browser.post(`/platform/mfa-resets/${filed.id}/approve`);
    expect(errorCode(self)).toBe('mfa_reset_self_approval');
    const refuses = (sql: string, params: unknown[], constraint: string) =>
      expect(owner.query(sql, params)).rejects.toMatchObject({ constraint });
    const approve =
      "UPDATE lms.mfa_reset_requests SET status = 'approved', approved_by = $2, approved_at = now(), execute_after = now() WHERE id = $1";
    await refuses(approve, [filed.id, admins[0]!.userId], 'mfa_reset_requests_approver_ck');
    await refuses(approve, [filed.id, target.userId], 'mfa_reset_requests_approver_ck');
    await refuses(
      "INSERT INTO lms.mfa_reset_requests (id, user_id, status, requested_at, requested_by, expires_at) VALUES ($1, $2, 'rejected', now(), $2, now())",
      [newId(), target.userId],
      'mfa_reset_requests_filer_ck',
    );
    ok(await decide(1, filed.id, 'approve'));
    ok(await decide(2, filed.id, 'cancel'));
  });

  it('approve, reject and cancel: only what is still open', async () => {
    const { who } = await subject();
    const one = ok(await file(0, who.email)).request;
    ok(await decide(1, one.id, 'reject'));
    expect(errorCode(await decide(2, one.id, 'approve'))).toBe('mfa_reset_not_pending');
    expect(errorCode(await decide(2, one.id, 'cancel'))).toBe('mfa_reset_too_late');
    const two = ok(await file(0, who.email)).request;
    const done = ok(await decide(1, two.id, 'approve')).request;
    expect(done.status).toBe('approved');
    expect(Date.parse(done.executeAfter) - clock.now().getTime()).toBe(DAY);
    expect(errorCode(await decide(2, two.id, 'approve'))).toBe('mfa_reset_not_pending');
    ok(await decide(0, two.id, 'cancel'));
    clock.advance((2 * DAY) / 1000);
    await run();
    expect(await state(who.userId)).toMatchObject({ factor: 1 });
    expect((await request(two.id)).status).toBe('cancelled');
    expect(errorCode(await decide(0, U, 'approve'))).toBe('mfa_reset_not_found');
  });
});

describe('time', () => {
  it('executed at 24 hours after the approval, not a millisecond before', async () => {
    const { A, who } = await subject();
    const id = await approved(who);
    const due = (await request(id)).execute_after.getTime() as number;
    moveTo(due - 1);
    expect(await run()).toMatchObject({ executed: 0 });
    expect((await state(who.userId)).factor).toBe(1);
    moveTo(due);
    expect(await run()).toMatchObject({ executed: 1 });
    expect(await state(who.userId)).toMatchObject({
      factor: 0,
      codes: 0,
      challenges: 0,
      sessions: 0,
      password: '!reset',
      requests: [{ status: 'done', reason: null }],
    });
    expect(await run()).toMatchObject({ executed: 0 });

    // what the person can do now: not sign in with the old password; choose a new one; enrol again
    expect((await who.browser.get('/auth/me')).statusCode).toBe(401);
    const signIn = await new TestClient(t, A.host).login(who.email, TEST_PASSWORD);
    expect([signIn.statusCode, errorCode(signIn)]).toEqual([401, 'invalid_credentials']);
    const anon = new TestClient(t, A.host);
    expect((await anon.post('/auth/password/forgot', { email: who.email })).statusCode).toBe(202);
    await waitForMail(t, who.email);
    const token = await lastTokenFor(t, who.email);
    ok(await anon.post('/auth/password/reset', { token, newPassword: 'a-brand-new-passphrase-9' }));
    const next = await new TestClient(t, A.host).login(who.email, 'a-brand-new-passphrase-9');
    expect([next.statusCode, next.json().step]).toEqual([202, 'enrol_email']);

    // audit: the platform log and the college the person administers; mail at filing, approval and execution
    for (const action of ['requested', 'approved', 'executed']) {
      expect(await platformAudits(who.userId, `auth.mfa_reset_${action}`)).toBe(1);
      expect(await collegeAudits(A.tenantId, who.userId, `auth.mfa_reset_${action}`)).toBe(1);
    }
    expect(await mails(who.email, /reset of your two-step sign-in was requested/)).toBe(1);
    expect(await mails(who.email, /will be reset in 24 hours/)).toBe(1);
    expect(await mails(who.email, /two-step sign-in was reset/)).toBe(1);
  });

  it('an undecided request expires at 7 days: approval refused from that instant on', async () => {
    const { who } = await subject();
    const filed = ok(await file(0, who.email)).request;
    const expires = Date.parse(filed.expiresAt);
    moveTo(expires - 1);
    expect(await run()).toMatchObject({ expired: 0 });
    moveTo(expires);
    expect(errorCode(await decide(1, filed.id, 'approve'))).toBe('mfa_reset_expired');
    expect(await run()).toMatchObject({ expired: 1 });
    expect((await request(filed.id)).status).toBe('expired');
    expect(await platformAudits(who.userId, 'auth.mfa_reset_expired')).toBe(1);
    // a new one can be filed at once, and approved a millisecond before it would expire
    const again = ok(await file(0, who.email)).request;
    moveTo(Date.parse(again.expiresAt) - 1);
    ok(await decide(1, again.id, 'approve'));
    ok(await decide(1, again.id, 'cancel'));
  });
});

describe('the person signs in', () => {
  it('with the app or with a recovery code: the open request is cancelled', async () => {
    const { A, who } = await subject();
    const id = await approved(who);
    const c = await challenge(t, who);
    ok(await c.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) }));
    expect(await request(id)).toMatchObject({
      status: 'cancelled',
      reason: 'subject_signed_in',
      decided_by: who.userId,
    });
    expect(await collegeAudits(A.tenantId, who.userId, 'auth.mfa_reset_cancelled')).toBe(1);

    const second = ok(await file(0, who.email)).request;
    const r = await challenge(t, who);
    ok(await r.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }));
    expect((await request(second.id)).status).toBe('cancelled');
  });

  it('a factor that is gone at execution time cancels the request and leaves the password alone', async () => {
    const { who } = await subject();
    const id = await approved(who);
    await owner.query('DELETE FROM lms.user_mfa WHERE user_id = $1', [who.userId]);
    clock.advance((DAY + HOUR) / 1000);
    expect(await run()).toMatchObject({ executed: 0, cancelled: 1 });
    expect(await request(id)).toMatchObject({ status: 'cancelled', reason: 'no_factor' });
    expect((await state(who.userId)).password).not.toBe('!reset');
  });
});

describe('colleges that are told', () => {
  it('every college where the person is an ACTIVE administrator, no other', async () => {
    const { A, who } = await subject();
    const B = await college();
    const C = await college();
    for (const [tenant, role] of [
      [B.tenantId, 'institution_admin'],
      [C.tenantId, 'member'],
    ]) {
      await owner.query(
        'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [newId(), tenant, who.userId, role],
      );
    }
    const filed = ok(await file(0, who.email)).request;
    expect(
      await Promise.all(
        [A, B, C].map((x) => collegeAudits(x.tenantId, who.userId, 'auth.mfa_reset_requested')),
      ),
    ).toEqual([1, 1, 0]);
    ok(await decide(0, filed.id, 'cancel'));
  });
});

describe('break glass and admin:create', () => {
  it('pnpm mfa:reset removes the factor at once, cancels an open request, audits and mails', async () => {
    const { A, who } = await subject();
    const id = await approved(who);
    const client = await owner.connect();
    try {
      expect(await breakGlassReset(client, 'nobody@nowhere.test')).toBe('not_found');
      expect(await breakGlassReset(client, A.memberEmail)).toBe('not_enrolled');
      expect(await breakGlassReset(client, who.email, clock.now())).toBe('ok');
    } finally {
      client.release();
    }
    expect(await state(who.userId)).toMatchObject({
      factor: 0,
      sessions: 0,
      password: '!reset',
      requests: [{ status: 'cancelled', reason: 'break_glass' }],
    });
    expect((await request(id)).status).toBe('cancelled');
    expect(await platformAudits(who.userId, 'auth.mfa_reset_break_glass')).toBe(1);
    expect(await collegeAudits(A.tenantId, who.userId, 'auth.mfa_reset_break_glass')).toBe(1);
    expect(await mails(who.email, /two-step sign-in was reset/)).toBe(1);
  });

  it('the application role cannot break the glass', async () => {
    const { rows } = await owner.query<{ can: boolean }>(
      "SELECT has_function_privilege('lms_app', 'lms.mfa_break_glass(text, timestamptz)', 'EXECUTE') AS can",
    );
    expect(rows[0]!.can).toBe(false);
  });

  it('admin:create ends the sessions and sign-ins in progress of an existing account', async () => {
    const { A, who } = await subject();
    const pending = await challenge(t, who);
    expect((await state(who.userId)).sessions).toBeGreaterThan(0);
    const client = await owner.connect();
    try {
      await bootstrapPlatformAdmin(client, {
        email: who.email,
        name: 'Promoted',
        passwordHash: (await state(who.userId)).password,
      });
    } finally {
      client.release();
    }
    expect((await state(who.userId)).sessions).toBe(0);
    expect((await who.browser.get('/auth/me')).statusCode).toBe(401);
    expect(
      errorCode(await pending.post('/auth/mfa/verify', { code: codeAt(who.secret, clock) })),
    ).toBe('mfa_challenge_invalid');
    // the second factor is untouched
    expect((await state(who.userId)).factor).toBe(1);
    expect(A.slug).toBeTruthy();
    await owner.query('UPDATE lms.users SET is_platform_admin = false WHERE id = $1', [who.userId]);
  });
});

describe('failure injection: no change without its audit rows', () => {
  const failsAtomically = async (userId: string, call: () => Promise<unknown>) => {
    const before = await state(userId);
    await injection.arm(true);
    try {
      await call();
    } finally {
      await injection.arm(false);
    }
    expect(await state(userId)).toEqual(before);
  };
  const is500 = async (res: PromiseLike<{ statusCode: number }>) =>
    expect((await res).statusCode).toBe(500);

  it('file, approve, reject, cancel, expire, execute', async () => {
    const { who } = await subject();
    await failsAtomically(who.userId, () => is500(file(0, who.email)));
    const filed = ok(await file(0, who.email)).request;
    for (const action of ['approve', 'reject', 'cancel'] as const) {
      await failsAtomically(who.userId, () => is500(decide(1, filed.id, action)));
    }
    moveTo(Date.parse(filed.expiresAt));
    await failsAtomically(who.userId, () => expect(run()).rejects.toThrow());
    ok(await decide(0, filed.id, 'cancel'));
    clock.reset();
    await approved(who);
    clock.advance((DAY + HOUR) / 1000);
    await failsAtomically(who.userId, () => expect(run()).rejects.toThrow());
    await run();
    expect((await state(who.userId)).factor).toBe(0);
  });

  it('the cancellation by sign-in, and the break glass', async () => {
    const { who } = await subject();
    await approved(who);
    const c = await challenge(t, who);
    await failsAtomically(who.userId, () =>
      is500(c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] })),
    );
    const client = await owner.connect();
    try {
      await failsAtomically(who.userId, () =>
        expect(breakGlassReset(client, who.email, clock.now())).rejects.toThrow(/injected failure/),
      );
    } finally {
      client.release();
    }
    ok(await c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }));
  });
});

describe('held-lock races', () => {
  const credentials = async (userId: string) => {
    const holder = await hold(owner);
    await holder.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [userId]);
    return holder;
  };

  it('a sign-in against the execution, the execution first: the sign-in gets nothing, no deadlock', async () => {
    const { who } = await subject();
    const id = await approved(who);
    const c = await challenge(t, who);
    clock.advance((DAY + HOUR) / 1000);
    // the challenge lives 5 minutes: keep it alive across the jump
    await owner.query('UPDATE lms.auth_mfa_challenges SET expires_at = $2 WHERE user_id = $1', [
      who.userId,
      new Date(clock.now().getTime() + HOUR),
    ]);
    const holder = await credentials(who.userId);
    try {
      const execution = Promise.resolve(run());
      await blocked(owner, '%mfa_reset_execute%');
      const signIn = Promise.resolve(
        c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }),
      );
      await blocked(owner, '%mfa_recovery_use%');
      await holder.commit();
      expect(await execution).toMatchObject({ executed: 1 });
      expect((await signIn).statusCode).toBe(401);
    } finally {
      await holder.commit();
    }
    expect((await request(id)).status).toBe('done');
    expect((await state(who.userId)).sessions).toBe(0);
  });

  it('a sign-in against the execution, the sign-in first: it is signed in and nothing is reset', async () => {
    const { who } = await subject();
    const id = await approved(who);
    const c = await challenge(t, who);
    clock.advance((DAY + HOUR) / 1000);
    await owner.query('UPDATE lms.auth_mfa_challenges SET expires_at = $2 WHERE user_id = $1', [
      who.userId,
      new Date(clock.now().getTime() + HOUR),
    ]);
    const holder = await credentials(who.userId);
    try {
      const signIn = Promise.resolve(
        c.post('/auth/mfa/verify', { recoveryCode: who.recoveryCodes[0] }),
      );
      await blocked(owner, '%mfa_recovery_use%');
      const execution = Promise.resolve(run());
      await blocked(owner, '%mfa_reset_execute%');
      await holder.commit();
      expect((await signIn).statusCode).toBe(200);
      expect(await execution).toMatchObject({ executed: 0 });
    } finally {
      await holder.commit();
    }
    expect((await request(id)).status).toBe('cancelled');
    expect((await state(who.userId)).factor).toBe(1);
  });

  it.each([
    ['approve', 'cancel', [200, 200], 'cancelled'],
    ['cancel', 'approve', [200, 409], 'cancelled'],
  ] as const)('%s against %s on one request', async (first, second, expected, final) => {
    const { who } = await subject();
    const filed = ok(await file(0, who.email)).request;
    const holder = await hold(owner);
    try {
      await holder.q('SELECT 1 FROM lms.mfa_reset_requests WHERE id = $1 FOR UPDATE', [filed.id]);
      const a = Promise.resolve(decide(1, filed.id, first));
      await blocked(owner, '%mfa_reset_decide%');
      const b = Promise.resolve(decide(2, filed.id, second));
      await blocked(owner, '%mfa_reset_decide%', 2);
      await holder.commit();
      expect([(await a).statusCode, (await b).statusCode]).toEqual(expected);
    } finally {
      await holder.commit();
    }
    expect((await request(filed.id)).status).toBe(final);
  });

  it('two filings at once: one request', async () => {
    const { who } = await subject();
    const holder = await hold(owner);
    try {
      await holder.q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `mfa.reset:${who.userId}`,
      ]);
      const both = [0, 1].map((i) => Promise.resolve(file(i, who.email)));
      await blocked(owner, '%mfa_reset_request%', 2);
      await holder.commit();
      expect((await Promise.all(both)).map((r) => r.statusCode).sort()).toEqual([202, 409]);
    } finally {
      await holder.commit();
    }
    expect((await state(who.userId)).requests).toHaveLength(1);
  });
});

describe('round-trip budgets', () => {
  const budget = async <T>(n: number, label: string, call: () => Promise<T>): Promise<T> => {
    await off.app.modules.background.drain();
    off.statements.reset();
    const result = await call();
    expect(off.statements.count, `${label}\n${off.statements.statements.join('\n')}`).toBe(n);
    return result;
  };

  it('every reset request', async () => {
    const { who } = await subject();
    const filed = ok(await budget(2, 'file', async () => file(0, who.email))).request;
    ok(await budget(2, 'list', async () => admins[0]!.client.get('/platform/mfa-resets')));
    ok(await budget(2, 'approve', async () => decide(1, filed.id, 'approve')));
    ok(await budget(2, 'cancel', async () => decide(1, filed.id, 'cancel')));
    const again = ok(await file(0, who.email)).request;
    ok(await budget(2, 'reject', async () => decide(1, again.id, 'reject')));
  });
});

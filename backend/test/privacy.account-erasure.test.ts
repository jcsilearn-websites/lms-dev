import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { TestClient } from './client';
import { loginAs, ok, type Person, person } from './courses-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// DATA PROTECTION, step 14b-1 part 4: ERASURE OF THE GLOBAL ACCOUNT, the workflow.
// Who may ask (a member of exactly one college: combined; a person with no active membership: a platform administrator, with a different
// administrator approving), the states and their mirrors, the 7 days of grace and the 30 days of expiry (explicit instants / owner-set
// dates, never the clock), the HELD-LOCK RACES of the execution (a new invite or a re-invite in another college, a duplicate request, a
// sign-in in flight), AUDIT ATOMICITY by failure injection for every state change, and the round-trip budgets. What the execution does
// to the data, the sentinel sweeps and the restore are test/privacy.account-erasure.execute.test.ts.

const SWITCH = 'public.pa_failure_switch';
const WRONG = 'definitely not the password';
const DAY = 86_400_000;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let B: AuthFixture;
let adminA: TestClient;
let adminB: TestClient;
let p1: TestClient;
let p2: TestClient;
let platform1: { userId: string; email: string };
let platform2: { userId: string; email: string };
let ledgerDir: string;
const svc = () => t.app.modules.privacy.erasureService;

const arm = (platformInsert: boolean, collegeInsert = false, collegeUpdate = false) =>
  owner.query(`UPDATE ${SWITCH} SET fail_platform = $1, fail_college = $2, fail_update = $3`, [
    platformInsert,
    collegeInsert,
    collegeUpdate,
  ]);

beforeAll(async () => {
  owner = testOwnerPool(8);
  for (const stmt of [
    'DROP TRIGGER IF EXISTS zz_pa_failure_plat ON lms.platform_audit_log',
    'DROP TRIGGER IF EXISTS zz_pa_failure_ins ON lms.audit_log',
    'DROP TRIGGER IF EXISTS zz_pa_failure_upd ON lms.audit_log',
    'DROP FUNCTION IF EXISTS public.pa_failure_fn()',
    `DROP TABLE IF EXISTS ${SWITCH}`,
    `CREATE TABLE ${SWITCH} (fail_platform boolean NOT NULL, fail_college boolean NOT NULL, fail_update boolean NOT NULL)`,
    `INSERT INTO ${SWITCH} VALUES (false, false, false)`,
    `CREATE FUNCTION public.pa_failure_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
     BEGIN
       IF TG_TABLE_NAME = 'platform_audit_log' AND NEW.action LIKE 'privacy.%' AND (SELECT fail_platform FROM public.pa_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the platform audit row could not be written' USING ERRCODE = 'XX000';
       END IF;
       IF TG_TABLE_NAME = 'audit_log' AND TG_OP = 'INSERT' AND NEW.action LIKE 'privacy.%' AND (SELECT fail_college FROM public.pa_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the audit row could not be written' USING ERRCODE = 'XX000';
       END IF;
       IF TG_TABLE_NAME = 'audit_log' AND TG_OP = 'UPDATE' AND (SELECT fail_update FROM public.pa_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the audit scrub could not be written' USING ERRCODE = 'XX000';
       END IF;
       RETURN NEW;
     END $$`,
    'CREATE TRIGGER zz_pa_failure_plat BEFORE INSERT ON lms.platform_audit_log FOR EACH ROW EXECUTE FUNCTION public.pa_failure_fn()',
    'CREATE TRIGGER zz_pa_failure_ins BEFORE INSERT ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.pa_failure_fn()',
    'CREATE TRIGGER zz_pa_failure_upd BEFORE UPDATE ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.pa_failure_fn()',
  ])
    await owner.query(stmt);
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-ledger-acc-'));
  t = makeApp({
    env: {
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_FAILURES_PER_IP: '100000',
      RATE_LIMIT_AUTH_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      LOGIN_MAX_ATTEMPTS: '50',
      DATA_EXPORT_RATE_PER_HOUR: '100000',
      TENANT_CACHE_TTL_MS: '3600000',
      ERASURE_LEDGER_DIR: ledgerDir,
      SUPPRESSION_HASH_KEYS: `k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`,
    },
  });
  A = await createAuthFixture(owner, 'acc-a');
  B = await createAuthFixture(owner, 'acc-b');
  platform1 = await createPlatformAdmin(owner, 'root1@acc.test');
  platform2 = await createPlatformAdmin(owner, 'root2@acc.test');
  await t.app.ready();
  adminA = await loginAs(t, A.host, A.adminEmail);
  adminB = await loginAs(t, B.host, B.adminEmail);
  p1 = await loginAs(t, 'admin.localhost', platform1.email);
  p2 = await loginAs(t, 'admin.localhost', platform2.email);
}, 120_000);

afterAll(async () => {
  await arm(false);
  await t.close();
  for (const stmt of [
    'DROP TRIGGER IF EXISTS zz_pa_failure_plat ON lms.platform_audit_log',
    'DROP TRIGGER IF EXISTS zz_pa_failure_ins ON lms.audit_log',
    'DROP TRIGGER IF EXISTS zz_pa_failure_upd ON lms.audit_log',
    'DROP FUNCTION IF EXISTS public.pa_failure_fn()',
    `DROP TABLE IF EXISTS ${SWITCH}`,
  ])
    await owner.query(stmt);
  await owner.end();
  await rm(ledgerDir, { recursive: true, force: true });
});

const holding = new Set<pg.PoolClient>();
/** A session of the test holding a transaction open (rolled back after the test when it was not committed). */
async function hold() {
  const c = await owner.connect();
  holding.add(c);
  await c.query('BEGIN');
  return {
    q: (sql: string, params: unknown[] = []) => c.query(sql, params),
    async commit() {
      await c.query('COMMIT');
      holding.delete(c);
      c.release();
    },
  };
}
afterEach(async () => {
  await arm(false);
  for (const c of holding) {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  holding.clear();
});

/** Waits until a statement matching `like` is blocked on a lock: the code under test has made its checks and waits to act. */
async function blocked(like: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await owner.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [like],
    );
    if ((r.rowCount ?? 0) > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`nothing matching ${like} was blocked on a lock`);
}

// ------------------------------------------------------------------------------------------------------------------ helpers
const ask = (c: TestClient, password = TEST_PASSWORD) =>
  c.post('/me/account-erasure', { password });
const file = (c: TestClient, email: string) => c.post('/platform/account-erasures', { email });
const decide = (c: TestClient, id: string, action: 'approve' | 'reject' | 'cancel') =>
  c.post(`/platform/account-erasures/${id}/${action}`, {});
const requests = async (userId: string) =>
  (
    await owner.query(
      'SELECT * FROM lms.account_erasure_requests WHERE user_id = $1 ORDER BY requested_at, id',
      [userId],
    )
  ).rows;
const request = async (id: string) =>
  (await owner.query('SELECT * FROM lms.account_erasure_requests WHERE id = $1', [id])).rows[0];
const userRow = async (userId: string) =>
  (await owner.query('SELECT * FROM lms.users WHERE id = $1', [userId])).rows[0];
const collegeRequests = async (userId: string) =>
  (
    await owner.query(
      'SELECT * FROM lms.erasure_requests WHERE user_id = $1 ORDER BY requested_at, id',
      [userId],
    )
  ).rows;
const platformAudit = async (action: string, id: string) =>
  (
    await owner.query('SELECT * FROM lms.platform_audit_log WHERE action = $1 AND target_id = $2', [
      action,
      id,
    ])
  ).rows;
/** a membership of the person in another college (or a removed one) */
async function addTo(tenantId: string, userId: string, status = 'active') {
  const id = newId();
  await owner.query(
    "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'member', $4)",
    [id, tenantId, userId, status],
  );
  return id;
}
/** a person who cannot sign in: every membership removed (an administrator's soft removal), never erased */
async function removedPerson(name: string, extraCollege = false): Promise<Person> {
  const m = await person(owner, t, A, name);
  if (extraCollege) await addTo(B.tenantId, m.userId, 'removed');
  await owner.query("UPDATE lms.tenant_memberships SET status = 'removed' WHERE user_id = $1", [
    m.userId,
  ]);
  return m;
}
/** files + approves a platform request and makes it due (the grace date is set by the owner: no waiting) */
async function dueRequest(m: Person): Promise<string> {
  const id = ok(await file(p1, m.email)).request.id as string;
  ok(await decide(p2, id, 'approve'));
  await owner.query(
    "UPDATE lms.account_erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
    [id],
  );
  return id;
}

// ------------------------------------------------------------------------------------------------------------------ who may ask
describe('who may ask for the erasure of an account', () => {
  it('a member of TWO colleges cannot ask here, and a platform administrator cannot file it either', async () => {
    const m = await person(owner, t, A, 'Two Colleges');
    await addTo(B.tenantId, m.userId);
    const r = await ask(m.client);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('account_erasure_not_eligible');
    expect(await requests(m.userId)).toEqual([]);
    expect(await collegeRequests(m.userId)).toEqual([]);
    expect(ok(await m.client.get('/me/account-erasure'))).toMatchObject({
      eligible: false,
      colleges: 2,
      request: null,
    });
    const f = await file(p1, m.email);
    expect(f.statusCode).toBe(409);
    expect(f.json().error.code).toBe('account_has_memberships');
    expect(await requests(m.userId)).toEqual([]);
  });

  it('a pending or suspended membership still counts: the person is not "without a membership"', async () => {
    for (const status of ['pending', 'suspended']) {
      const m = await removedPerson(`Still ${status}`);
      await addTo(B.tenantId, m.userId, status);
      expect((await file(p1, m.email)).json().error.code).toBe('account_has_memberships');
    }
  });

  it('the password is asked again: a wrong one writes nothing', async () => {
    const m = await person(owner, t, A, 'Wrong Password');
    const r = await ask(m.client, WRONG);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_current_password');
    expect(await requests(m.userId)).toEqual([]);
    expect(await collegeRequests(m.userId)).toEqual([]);
  });

  it('an account of a platform administrator is never erased here; an unknown address is a 404', async () => {
    const r = await file(p1, platform2.email);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('account_not_erasable');
    expect((await file(p1, 'nobody-at-all@acc.test')).statusCode).toBe(404);
  });

  it('only a platform administrator can use the platform routes (a college admin, a member and a visitor cannot)', async () => {
    const m = await removedPerson('Nobody Files');
    for (const c of [adminA, new TestClient(t, 'admin.localhost')]) {
      expect([401, 403, 404]).toContain((await file(c, m.email)).statusCode);
    }
    expect((await adminA.get('/platform/account-erasures')).statusCode).not.toBe(200);
    expect(await requests(m.userId)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ combined
describe('combined: a member of exactly one college asks for the college erasure AND the account erasure', () => {
  it('the college half waits for an administrator, the account half waits for the college half; one scan runs both', async () => {
    const m = await person(owner, t, A, 'Combined One');
    expect(ok(await m.client.get('/me/account-erasure'))).toMatchObject({
      eligible: true,
      colleges: 1,
      request: null,
    });
    const r = await ask(m.client);
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body).toMatchObject({
      alreadyInProgress: false,
      request: { status: 'waiting_college', source: 'member_combined' },
      collegeRequest: { status: 'pending_approval' },
    });
    // asking again is the same request, nothing new
    const again = ask(m.client);
    expect((await again).json()).toMatchObject({ alreadyInProgress: true });
    expect(await requests(m.userId)).toHaveLength(1);
    expect(await collegeRequests(m.userId)).toHaveLength(1);
    // the administrators see that the whole account goes with it
    const list = ok(await adminA.get('/privacy/erasure-requests')).items as {
      id: string;
      withAccount: boolean;
    }[];
    expect(list.find((x) => x.id === body.collegeRequest.id)?.withAccount).toBe(true);
    // a plain college request (not combined) is not marked
    const plain = await person(owner, t, A, 'Plain College');
    ok(await plain.client.post('/me/erasure', { password: TEST_PASSWORD }));
    const list2 = ok(await adminA.get('/privacy/erasure-requests')).items as {
      memberName: string;
      withAccount: boolean;
    }[];
    expect(list2.find((x) => x.memberName.includes('Plain College'))?.withAccount).toBe(false);
    // nothing happens before the college half is approved and its grace period is over
    await svc().scan();
    expect((await request(body.request.id)).status).toBe('waiting_college');
    ok(await adminA.post(`/privacy/erasure-requests/${body.collegeRequest.id}/approve`, {}));
    await svc().scan();
    expect((await request(body.request.id)).status).toBe('waiting_college');
    expect((await userRow(m.userId)).erased_at).toBeNull();
    // the grace period ends: ONE scan executes the college erasure, then the account erasure
    await owner.query(
      "UPDATE lms.erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
      [body.collegeRequest.id],
    );
    const out = await svc().scan();
    expect(out.erased).toBeGreaterThanOrEqual(1);
    expect(out.accountsReady).toBeGreaterThanOrEqual(1);
    expect(out.accountsErased).toBeGreaterThanOrEqual(1);
    expect((await request(body.request.id)).status).toBe('done');
    expect((await userRow(m.userId)).erased_at).not.toBeNull();
    // no way back in: the old address is not an account, the new one has no password
    const gone = await new TestClient(t, A.host).login(m.email, TEST_PASSWORD);
    expect(gone.statusCode).toBe(401);
  }, 60_000);

  it('the college half ending (cancelled by the member, rejected, expired) ends the account half with it', async () => {
    const a = await person(owner, t, A, 'Combined Cancel');
    const ra = ok(await ask(a.client));
    ok(await a.client.post('/me/erasure/cancel', {}));
    const b = await person(owner, t, A, 'Combined Reject');
    const rb = ok(await ask(b.client));
    ok(await adminA.post(`/privacy/erasure-requests/${rb.collegeRequest.id}/reject`, {}));
    const c = await person(owner, t, A, 'Combined Expire');
    const rc = ok(await ask(c.client));
    await owner.query(
      "UPDATE lms.erasure_requests SET expires_at = now() - interval '1 day' WHERE id = $1",
      [rc.collegeRequest.id],
    );
    const out = await svc().scan();
    expect(out.accountsClosed).toBeGreaterThanOrEqual(3);
    expect((await request(ra.request.id)).status).toBe('cancelled');
    expect((await request(rb.request.id)).status).toBe('rejected');
    expect((await request(rc.request.id)).status).toBe('expired');
    for (const m of [a, b, c]) expect((await userRow(m.userId)).erased_at).toBeNull();
    // they can ask again afterwards
    expect((await ask(a.client)).statusCode).toBe(202);
  }, 60_000);

  it('the last administrator of a college cannot erase the account (the college rule applies)', async () => {
    const solo = await createAuthFixture(owner, 'acc-solo');
    const c = await loginAs(t, solo.host, solo.adminEmail);
    // the fixture's college has exactly one institution admin: erasing them would leave the college without one
    const r = await ask(c);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('last_admin');
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.account_erasure_requests WHERE user_id = $1',
          [solo.adminUserId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------ platform path
describe('platform path: a person with no active membership, filed by one platform administrator and approved by ANOTHER', () => {
  it('file -> (not the same administrator) approve -> 7 days of grace -> the scan executes it; every college of the person gets its pseudonym', async () => {
    const m = await removedPerson('Platform One', true);
    const f = await file(p1, m.email);
    expect(f.statusCode).toBe(202);
    const id = f.json().request.id as string;
    expect(f.json().request).toMatchObject({ status: 'pending_approval', source: 'platform' });
    // a second request for the same person is refused
    const dup = await file(p2, m.email);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('account_erasure_in_progress');
    // the one who filed it cannot approve or reject it
    for (const action of ['approve', 'reject'] as const) {
      const r = await decide(p1, id, action);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('self_approval_not_allowed');
    }
    // the lists tell each administrator what they can do (and show the person while they exist)
    const l1 = ok(await p1.get('/platform/account-erasures')).items as Record<string, unknown>[];
    const l2 = ok(await p2.get('/platform/account-erasures')).items as Record<string, unknown>[];
    expect(l1.find((x) => x.id === id)).toMatchObject({
      canApprove: false,
      canCancel: true,
      personEmail: m.email,
      erased: false,
    });
    expect(l2.find((x) => x.id === id)).toMatchObject({ canApprove: true });
    // approve: grace of 7 days from the approval instant
    const before = Date.now();
    const ap = ok(await decide(p2, id, 'approve')).request;
    expect(ap.status).toBe('approved');
    const grace = Date.parse(ap.graceUntil);
    expect(grace - before).toBeGreaterThan(7 * DAY - 60_000);
    expect(grace - before).toBeLessThan(7 * DAY + 60_000);
    expect((await platformAudit('privacy.account_erasure_approved', id))[0].actor_user_id).toBe(
      platform2.userId,
    );
    // not due yet
    const early = await svc().scan();
    expect(early.accountsErased).toBe(0);
    expect((await userRow(m.userId)).erased_at).toBeNull();
    // due: executed
    await owner.query(
      "UPDATE lms.account_erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
      [id],
    );
    const out = await svc().scan();
    expect(out.accountsErased).toBe(1);
    expect((await request(id)).status).toBe('done');
    // BOTH colleges got their pseudonym through an internal request that is done and needs no ledger line of its own
    const overrides = await owner.query(
      'SELECT o.tenant_id FROM lms.membership_display_overrides o JOIN lms.tenant_memberships m ON m.id = o.membership_id WHERE m.user_id = $1',
      [m.userId],
    );
    expect(overrides.rows.map((r) => r.tenant_id).sort()).toEqual([A.tenantId, B.tenantId].sort());
    const internal = await collegeRequests(m.userId);
    expect(internal).toHaveLength(2);
    for (const r of internal)
      expect(r).toMatchObject({ source: 'account', status: 'done', ledger_at: expect.any(Date) });
    // the platform list now shows the pseudonym and no address
    const after = (
      ok(await p2.get('/platform/account-erasures')).items as Record<string, unknown>[]
    ).find((x) => x.id === id);
    expect(after).toMatchObject({ status: 'done', erased: true, personEmail: null });
    expect(String(after?.personName)).toMatch(/^Former user [0-9A-F]{8}$/);
    // asking again with the old address finds nobody
    expect((await file(p1, m.email)).statusCode).toBe(404);
  }, 60_000);

  it('cancel works until the grace period ends and not after; reject ends an undecided request', async () => {
    const m = await removedPerson('Platform Cancel');
    const id = ok(await file(p1, m.email)).request.id as string;
    ok(await decide(p2, id, 'approve'));
    // either administrator can cancel while the grace period runs
    const c = await decide(p1, id, 'cancel');
    expect(c.statusCode).toBe(200);
    expect((await request(id)).status).toBe('cancelled');
    expect((await decide(p2, id, 'cancel')).json().error.code).toBe('erasure_too_late');
    const n = await removedPerson('Platform Reject');
    const id2 = ok(await file(p1, n.email)).request.id as string;
    ok(await decide(p2, id2, 'reject'));
    expect((await request(id2)).status).toBe('rejected');
    // a cancelled request can be filed again
    expect((await file(p1, m.email)).statusCode).toBe(202);
    // a cancel at the very instant the grace period ends is too late (explicit instants, the database function)
    const k = await removedPerson('Platform Boundary');
    const id3 = ok(await file(p1, k.email)).request.id as string;
    const T = new Date('2026-06-01T09:00:00Z');
    await owner.query(
      "UPDATE lms.account_erasure_requests SET status = 'approved', approved_by = $2, grace_until = $3 WHERE id = $1",
      [id3, platform2.userId, new Date(T.getTime() + 7 * DAY).toISOString()],
    );
    const call = async (now: Date) =>
      (
        await owner.query(
          "SELECT lms.privacy_account_platform_decide($1, $2, 'cancel', $3::timestamptz, NULL) AS r",
          [platform1.userId, id3, now.toISOString()],
        )
      ).rows[0].r;
    expect((await call(new Date(T.getTime() + 7 * DAY))).result).toBe('too_late');
    expect((await call(new Date(T.getTime() + 7 * DAY - 1000))).result).toBe('ok');
  });

  it('an undecided request expires after 30 days; approving an expired one is refused', async () => {
    const m = await removedPerson('Platform Expire');
    const id = ok(await file(p1, m.email)).request.id as string;
    const T = new Date('2026-07-01T09:00:00Z');
    await owner.query(
      'UPDATE lms.account_erasure_requests SET requested_at = $2, expires_at = $3 WHERE id = $1',
      [id, T.toISOString(), new Date(T.getTime() + 30 * DAY).toISOString()],
    );
    const approveAt = async (now: Date) =>
      (
        await owner.query(
          "SELECT lms.privacy_account_platform_decide($1, $2, 'approve', $3::timestamptz, NULL) AS r",
          [platform2.userId, id, now.toISOString()],
        )
      ).rows[0].r.result;
    expect(await approveAt(new Date(T.getTime() + 30 * DAY))).toBe('expired');
    const sync = async (now: Date) =>
      (
        await owner.query('SELECT lms.privacy_account_sync($1::timestamptz, 100) AS r', [
          now.toISOString(),
        ])
      ).rows[0].r;
    expect((await sync(new Date(T.getTime() + 30 * DAY - 1000))).expired).toBe(0);
    expect((await sync(new Date(T.getTime() + 30 * DAY))).expired).toBe(1);
    expect((await request(id)).status).toBe('expired');
    expect((await platformAudit('privacy.account_erasure_expired', id)).length).toBe(1);
    expect((await userRow(m.userId)).erased_at).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ races
describe('RACES (a transaction of the test holds what the execution needs, the execution starts, waits, then the holder commits)', () => {
  it('against a NEW membership in another college: the person is NOT erased, the request is refused, the membership stays', async () => {
    const m = await removedPerson('Race Invite');
    const id = await dueRequest(m);
    const h = await hold();
    const newMembership = newId();
    // an invite to college B being written: its guard holds the user row FOR SHARE until it commits
    await h.q(
      "INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'pending')",
      [newMembership, B.tenantId, m.userId],
    );
    const run = svc().scanAccounts();
    await blocked('%privacy_account_execute%');
    await h.commit();
    const out = await run;
    expect(out).toMatchObject({ erased: 0, blocked: 1 });
    expect((await userRow(m.userId)).erased_at).toBeNull();
    expect((await request(id)).status).toBe('rejected');
    expect((await request(id)).reason).toBe('has_membership');
    expect(
      (
        await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [
          newMembership,
        ])
      ).rows[0].status,
    ).toBe('pending');
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.membership_display_overrides o JOIN lms.tenant_memberships m ON m.id = o.membership_id WHERE m.user_id = $1',
          [m.userId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await platformAudit('privacy.account_erasure_blocked', id)).length).toBe(1);
  });

  it('against a RE-INVITE of a removed membership (the same row goes back to pending): the same', async () => {
    const m = await removedPerson('Race Reinvite');
    const id = await dueRequest(m);
    const h = await hold();
    await h.q("UPDATE lms.tenant_memberships SET status = 'pending' WHERE user_id = $1", [
      m.userId,
    ]);
    const run = svc().scanAccounts();
    await blocked('%privacy_account_execute%');
    await h.commit();
    expect(await run).toMatchObject({ erased: 0, blocked: 1 });
    expect((await userRow(m.userId)).erased_at).toBeNull();
    expect((await request(id)).reason).toBe('has_membership');
  });

  it('an invite that arrives WHILE the account is being erased is refused after the commit (409 account_erased, no membership)', async () => {
    const m = await removedPerson('RaceLateInvite');
    const h = await hold();
    // the erasing transaction holds the user row
    await h.q('SELECT 1 FROM lms.users WHERE id = $1 FOR UPDATE', [m.userId]);
    const invite = adminB.post('/auth/invites', {
      email: m.email,
      role: 'member',
      displayName: 'Late Invite',
    });
    await blocked('%tenant_memberships%');
    await h.q(
      "UPDATE lms.users SET erased_at = now(), email = $2, display_name = 'Former user 00000000' WHERE id = $1",
      [m.userId, `erased-${m.userId.replaceAll('-', '')}@erased.invalid`],
    );
    await h.commit();
    const res = await invite;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('account_erased');
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE user_id = $1 AND tenant_id = $2',
          [m.userId, B.tenantId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('a membership, a session or a token can never be created for an erased account (the guard, not the application)', async () => {
    const m = await removedPerson('Race After');
    await dueRequest(m);
    expect((await svc().scanAccounts()).erased).toBe(1);
    await expect(addTo(B.tenantId, m.userId)).rejects.toThrow(/account was erased/);
    await expect(
      owner.query(
        "UPDATE lms.tenant_memberships SET status = 'active' WHERE user_id = $1 AND tenant_id = $2",
        [m.userId, A.tenantId],
      ),
    ).rejects.toThrow(/account was erased/);
    await expect(
      owner.query(
        "INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, NULL, now() + interval '1 day', now() + interval '1 day')",
        [newId(), randomBytes(32), m.userId],
      ),
    ).rejects.toThrow(/account was erased/);
    await expect(
      owner.query(
        "INSERT INTO lms.auth_tokens (id, purpose, token_hash, user_id, tenant_id, expires_at) VALUES ($1, 'password_reset', $2, $3, $4, now() + interval '1 day')",
        [newId(), randomBytes(32), m.userId, A.tenantId],
      ),
    ).rejects.toThrow(/account was erased/);
    // removing is still allowed (it is what the erasure itself does)
    await owner.query(
      "UPDATE lms.tenant_memberships SET status = 'removed' WHERE user_id = $1 AND tenant_id = $2",
      [m.userId, A.tenantId],
    );
  });

  it('against a DUPLICATE request: exactly one request exists (platform path and combined path)', async () => {
    const m = await removedPerson('Race Duplicate');
    const h = await hold();
    await h.q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `privacy.erasure:${m.userId}`,
    ]);
    const both = Promise.all([file(p1, m.email), file(p2, m.email)]);
    await blocked('%privacy_account_platform_request%');
    await h.commit();
    const res = await both;
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(await requests(m.userId)).toHaveLength(1);

    const c = await person(owner, t, A, 'Race Duplicate Combined');
    const h2 = await hold();
    await h2.q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `privacy.erasure:${c.userId}`,
    ]);
    const two = Promise.all([ask(c.client), ask(c.client)]);
    await blocked('%privacy_account_request_combined%');
    await h2.commit();
    const r2 = await two;
    expect(r2.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(r2.filter((r) => r.json().alreadyInProgress)).toHaveLength(1);
    expect(await requests(c.userId)).toHaveLength(1);
    expect(await collegeRequests(c.userId)).toHaveLength(1);
  });

  it('against a SIGN-IN in flight: a session created while the execution waits is revoked by it, and nothing signs in afterwards', async () => {
    const m = await removedPerson('Race Login');
    const id = await dueRequest(m);
    const h = await hold();
    // a sign-in holds the credentials row (auth_login_complete: FOR UPDATE) and is about to insert its session
    await h.q('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [m.userId]);
    const run = svc().scanAccounts();
    await blocked('%privacy_account_execute%');
    const sessionId = newId();
    await h.q(
      "INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day')",
      [sessionId, randomBytes(32), m.userId, A.tenantId],
    );
    await h.commit();
    expect((await run).erased).toBe(1);
    expect((await request(id)).status).toBe('done');
    const s = (
      await owner.query('SELECT revoked_at, ip, user_agent FROM lms.sessions WHERE id = $1', [
        sessionId,
      ])
    ).rows[0];
    expect(s.revoked_at).not.toBeNull();
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [m.userId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.user_credentials WHERE user_id = $1',
          [m.userId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------ audit atomicity
describe('AUDIT ATOMICITY: when an audit row cannot be written, the change does not happen (failure injection)', () => {
  it('platform request: no request row', async () => {
    const m = await removedPerson('Atomic File');
    await arm(true);
    expect((await file(p1, m.email)).statusCode).toBe(500);
    await arm(false);
    expect(await requests(m.userId)).toEqual([]);
    expect((await file(p1, m.email)).statusCode).toBe(202);
  });

  it('approve, reject and cancel: the request keeps its state', async () => {
    const m = await removedPerson('Atomic Decide');
    const id = ok(await file(p1, m.email)).request.id as string;
    await arm(true);
    for (const action of ['approve', 'reject'] as const)
      expect((await decide(p2, id, action)).statusCode).toBe(500);
    expect((await request(id)).status).toBe('pending_approval');
    expect((await request(id)).grace_until).toBeNull();
    await arm(false);
    ok(await decide(p2, id, 'approve'));
    await arm(true);
    expect((await decide(p1, id, 'cancel')).statusCode).toBe(500);
    await arm(false);
    expect((await request(id)).status).toBe('approved');
  });

  it('combined request: neither the account request nor the college request exists', async () => {
    const m = await person(owner, t, A, 'Atomic Combined');
    await arm(false, true);
    expect((await ask(m.client)).statusCode).toBe(500);
    await arm(false);
    expect(await requests(m.userId)).toEqual([]);
    expect(await collegeRequests(m.userId)).toEqual([]);
    expect((await ask(m.client)).statusCode).toBe(202);
  });

  it('expiry and the combined request following its college half: the state stays and the next run does it', async () => {
    const m = await removedPerson('Atomic Expiry');
    const id = ok(await file(p1, m.email)).request.id as string;
    await owner.query(
      "UPDATE lms.account_erasure_requests SET expires_at = now() - interval '1 day' WHERE id = $1",
      [id],
    );
    await arm(true);
    await expect(svc().scanAccounts()).rejects.toThrow();
    await arm(false);
    expect((await request(id)).status).toBe('pending_approval');
    expect((await svc().scanAccounts()).expired).toBeGreaterThanOrEqual(1);
    expect((await request(id)).status).toBe('expired');

    const c = await person(owner, t, A, 'Atomic Follow');
    const rc = ok(await ask(c.client));
    ok(await c.client.post('/me/erasure/cancel', {}));
    await arm(false, true);
    await expect(svc().scanAccounts()).rejects.toThrow();
    await arm(false);
    expect((await request(rc.request.id)).status).toBe('waiting_college');
    await svc().scanAccounts();
    expect((await request(rc.request.id)).status).toBe('cancelled');
  });

  for (const [what, platform, college, update] of [
    ['the "executed" platform audit row', true, false, false],
    ['the college "executed" audit rows', false, true, false],
    ['the scrub of the audit trail', false, false, true],
  ] as const) {
    it(`execute, failing at ${what}: the account is exactly as before (credentials, sessions, address, memberships, no override), and the retry completes`, async () => {
      const m = await removedPerson(`Atomic Exec ${platform ? 'P' : college ? 'C' : 'S'}`, true);
      await owner.query(
        'INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, \'test.scrub_me\', \'user\', $4, \'{"ip":"10.1.1.1","keep":1}\')',
        [newId(), A.tenantId, m.userId, m.userId],
      );
      const id = await dueRequest(m);
      const sessionBefore = (
        await owner.query(
          'SELECT count(*)::int AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [m.userId],
        )
      ).rows[0].n;
      await arm(platform, college, update);
      await expect(svc().scanAccounts()).rejects.toThrow();
      await arm(false);
      expect((await request(id)).status).toBe('approved');
      const u = await userRow(m.userId);
      expect(u.erased_at).toBeNull();
      expect(u.email).toBe(m.email);
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.user_credentials WHERE user_id = $1',
            [m.userId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.sessions WHERE user_id = $1 AND revoked_at IS NULL',
            [m.userId],
          )
        ).rows[0].n,
      ).toBe(sessionBefore);
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.membership_display_overrides o JOIN lms.tenant_memberships mm ON mm.id = o.membership_id WHERE mm.user_id = $1',
            [m.userId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await collegeRequests(m.userId)).toEqual([]);
      expect(
        (
          await owner.query(
            "SELECT metadata FROM lms.audit_log WHERE actor_user_id = $1 AND action = 'test.scrub_me'",
            [m.userId],
          )
        ).rows[0].metadata,
      ).toEqual({ ip: '10.1.1.1', keep: 1 });
      expect((await svc().scanAccounts()).erased).toBe(1);
      expect((await userRow(m.userId)).erased_at).not.toBeNull();
    });
  }

  it('the audit trail is still append-only for everyone: the erasure is the only way past the guard, and only for its own request', async () => {
    const m = await removedPerson('Guard');
    await expect(
      owner.query("UPDATE lms.audit_log SET metadata = '{}' WHERE actor_user_id = $1", [
        A.adminUserId,
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query('DELETE FROM lms.audit_log WHERE tenant_id = $1', [A.tenantId]),
    ).rejects.toThrow();
    // the internal function refuses a request that is not executing
    await expect(
      owner.query('SELECT lms.privacy_account_erase_core($1, now(), $2, $3, $4)', [
        newId(),
        m.email,
        randomBytes(32),
        'k2',
      ]),
    ).rejects.toThrow(/not executing/);
    const id = await dueRequest(m);
    expect((await request(id)).status).toBe('approved');
    await expect(
      owner.query('SELECT lms.privacy_account_erase_core($1, now(), $2, $3, $4)', [
        id,
        m.email,
        randomBytes(32),
        'k2',
      ]),
    ).rejects.toThrow(/not executing/);
  });
});

// ------------------------------------------------------------------------------------------------------------------ budgets
describe('query budgets (round trips, the session lookup included)', () => {
  const count = async (fn: () => Promise<{ statusCode: number }>) => {
    t.statements.reset();
    const r = await fn();
    await t.app.modules.background.drain();
    return { n: t.statements.statements.length, status: r.statusCode };
  };
  const line = (name: string, n: number, max: number) =>
    process.stdout.write(`ROUND-TRIPS ${name}: ${n} (budget ${max})\n`);

  it('my account request 2, ask 3 (a refused password 3); platform list 2, file 2, approve 2, cancel 2', async () => {
    const m = await person(owner, t, A, 'Budget Cy');
    await m.client.get('/me/account-erasure'); // warm: slug cache, the activity touch of the day
    await p1.get('/platform/account-erasures');
    const mine = await count(() => m.client.get('/me/account-erasure'));
    line('GET /me/account-erasure', mine.n, 2);
    expect(mine.n).toBeLessThanOrEqual(2);
    const wrong = await count(() => ask(m.client, WRONG));
    expect(wrong.status).toBe(400);
    line('POST /me/account-erasure (wrong password)', wrong.n, 3);
    expect(wrong.n).toBeLessThanOrEqual(3);
    const good = await count(() => ask(m.client));
    expect(good.status).toBe(202);
    line('POST /me/account-erasure', good.n, 3);
    expect(good.n).toBeLessThanOrEqual(3);

    const r = await removedPerson('Budget Dee');
    const list = await count(() => p1.get('/platform/account-erasures'));
    line('GET /platform/account-erasures', list.n, 2);
    expect(list.n).toBeLessThanOrEqual(2);
    const f = await count(() => file(p1, r.email));
    expect(f.status).toBe(202);
    line('POST /platform/account-erasures', f.n, 2);
    expect(f.n).toBeLessThanOrEqual(2);
    const id = (await requests(r.userId))[0].id as string;
    const ap = await count(() => decide(p2, id, 'approve'));
    expect(ap.status).toBe(200);
    line('POST /platform/account-erasures/:id/approve', ap.n, 2);
    expect(ap.n).toBeLessThanOrEqual(2);
    const cancel = await count(() => decide(p1, id, 'cancel'));
    expect(cancel.status).toBe(200);
    line('POST /platform/account-erasures/:id/cancel', cancel.n, 2);
    expect(cancel.n).toBeLessThanOrEqual(2);
  });
});

void DAY;

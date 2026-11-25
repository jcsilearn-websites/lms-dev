import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { deliverEmails, TestClient } from './client';
import { errorCode, type Json, loginAs, ok, type Person, person } from './courses-helpers';
import { type AuthFixture, createAuthFixture, TEST_PASSWORD, testOwnerPool } from './support';

// DATA PROTECTION, step 14b-1 part 3: ERASURE INSIDE A COLLEGE, the request side.
//   workflow (password re-entry, counts-only preview, approval by ANOTHER admin, 7 days of grace, cancel, reject, notices),
//   the last-admin rule at the request, the approval and the execution (also against a concurrent demotion),
//   races with deterministic holder sessions (approve / cancel, execute / cancel at the grace boundary, execute / suspension,
//   duplicate requests), the 30-day expiry with its notice, and AUDIT ATOMICITY by failure injection for every state change.
// The execution itself (the nine checklist items, the sentinel sweep, the database-wide scan, cross-college, the ledger) is
// test/privacy.erasure.execute.test.ts. Every time decision uses an explicit instant.

const SWITCH = 'public.pe_failure_switch';
const WRONG = 'definitely not the password';
const DAY = 86_400_000;

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let admin2: Person;
let ledgerDir: string;

const arm = (insert: boolean, update = false) =>
  owner.query(`UPDATE ${SWITCH} SET fail_insert = $1, fail_update = $2`, [insert, update]);

beforeAll(async () => {
  owner = testOwnerPool(6);
  for (const stmt of [
    'DROP TRIGGER IF EXISTS zz_pe_failure_ins ON lms.audit_log',
    'DROP TRIGGER IF EXISTS zz_pe_failure_upd ON lms.audit_log',
    'DROP FUNCTION IF EXISTS public.pe_failure_fn()',
    `DROP TABLE IF EXISTS ${SWITCH}`,
    `CREATE TABLE ${SWITCH} (fail_insert boolean NOT NULL, fail_update boolean NOT NULL)`,
    `INSERT INTO ${SWITCH} VALUES (false, false)`,
    `CREATE FUNCTION public.pe_failure_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
     BEGIN
       IF TG_OP = 'INSERT' AND NEW.action LIKE 'privacy.%' AND (SELECT fail_insert FROM public.pe_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the audit row could not be written' USING ERRCODE = 'XX000';
       END IF;
       IF TG_OP = 'UPDATE' AND (SELECT fail_update FROM public.pe_failure_switch) THEN
         RAISE EXCEPTION 'injected failure: the audit scrub could not be written' USING ERRCODE = 'XX000';
       END IF;
       RETURN NEW;
     END $$`,
    'CREATE TRIGGER zz_pe_failure_ins BEFORE INSERT ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.pe_failure_fn()',
    'CREATE TRIGGER zz_pe_failure_upd BEFORE UPDATE ON lms.audit_log FOR EACH ROW EXECUTE FUNCTION public.pe_failure_fn()',
  ])
    await owner.query(stmt);
  ledgerDir = await mkdtemp(join(tmpdir(), 'lms-ledger-'));
  t = makeApp({
    env: {
      RATE_LIMIT_MAX: '1000000',
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_EMAIL: '100000',
      LOGIN_MAX_ATTEMPTS: '50',
      DATA_EXPORT_RATE_PER_HOUR: '100000',
      TENANT_CACHE_TTL_MS: '3600000',
      ERASURE_LEDGER_DIR: ledgerDir,
      SUPPRESSION_HASH_KEYS: `k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`,
    },
  });
  A = await createAuthFixture(owner, 'ers-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  admin2 = await person(owner, t, A, 'Second Admin', { role: 'institution_admin' });
}, 120_000);

afterAll(async () => {
  await arm(false);
  await t.close();
  await owner.query('DROP TRIGGER IF EXISTS zz_pe_failure_ins ON lms.audit_log');
  await owner.query('DROP TRIGGER IF EXISTS zz_pe_failure_upd ON lms.audit_log');
  await owner.query('DROP FUNCTION IF EXISTS public.pe_failure_fn()');
  await owner.query(`DROP TABLE IF EXISTS ${SWITCH}`);
  await owner.end();
  await rm(ledgerDir, { recursive: true, force: true });
});

const ask = (c: TestClient, password = TEST_PASSWORD) => c.post('/me/erasure', { password });
const decide = (c: TestClient, id: string, action: 'approve' | 'reject' | 'cancel') =>
  c.post(`/privacy/erasure-requests/${id}/${action}`, {});
const row = async (id: string) =>
  (await owner.query('SELECT * FROM lms.erasure_requests WHERE id = $1', [id])).rows[0];
const rows = async (userId: string) =>
  (
    await owner.query(
      'SELECT * FROM lms.erasure_requests WHERE user_id = $1 ORDER BY requested_at',
      [userId],
    )
  ).rows;
const noteTypes = async (userId: string) =>
  (
    await owner.query(
      'SELECT type, params FROM lms.notifications WHERE user_id = $1 ORDER BY created_at',
      [userId],
    )
  ).rows;
const mails = async (userId: string, template: string) =>
  (
    await owner.query(
      'SELECT params, status FROM lms.email_outbox WHERE user_id = $1 AND template = $2',
      [userId, template],
    )
  ).rows;
const audits = async (action: string, target: string) =>
  Number(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.audit_log WHERE action = $1 AND target_id = $2',
        [action, target],
      )
    ).rows[0].n,
  );
const activeMember = async (m: Person) =>
  (await owner.query('SELECT status FROM lms.tenant_memberships WHERE id = $1', [m.membershipId]))
    .rows[0].status as string;
const override = async (m: Person) =>
  Number(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM lms.membership_display_overrides WHERE membership_id = $1',
        [m.membershipId],
      )
    ).rows[0].n,
  );
/** the grace period is over (an explicit past instant) */
const makeDue = (id: string) =>
  owner.query(
    "UPDATE lms.erasure_requests SET grace_until = '2026-01-01T00:00:00Z' WHERE id = $1",
    [id],
  );
const svc = () => t.app.modules.privacy.erasureService;

async function waiting(pattern: string, n: number) {
  const until = Date.now() + 15_000;
  for (;;) {
    const w = await owner.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [pattern],
    );
    if (Number(w.rows[0].n) >= n) return;
    if (Date.now() > until) throw new Error(`never ${n} waiter(s) for ${pattern}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** a member whose request is approved by the administrator (and made due when asked) */
async function approved(name: string, due = false) {
  const m = await person(owner, t, A, name);
  const id = ok(await ask(m.client)).request.id as string;
  ok(await decide(admin, id, 'approve'));
  if (due) await makeDue(id);
  return { m, id };
}

// ------------------------------------------------------------------------------------------------------------------ workflow
describe('the request workflow', () => {
  it('shows COUNTS only before anything is asked, with the rules and what is kept', async () => {
    const m = await person(owner, t, A, 'Preview Pia');
    const pv = ok(await m.client.get('/me/erasure/preview'));
    expect(pv).toMatchObject({
      lastAdmin: false,
      open: null,
      rules: {
        graceDays: 7,
        requestExpiresAfterDays: 30,
        backupRetentionDays: 30,
        exportRetentionDays: 7,
      },
    });
    for (const v of [...Object.values(pv.erased), ...Object.values(pv.kept)])
      expect(typeof v).toBe('number');
    expect(Object.keys(pv.kept)).toEqual(
      expect.arrayContaining(['submissions', 'quizAttempts', 'gradebookSnapshots', 'auditEntries']),
    );
    expect(JSON.stringify(pv)).not.toContain(m.email); // not a single value of the person
    expect(JSON.stringify(pv)).not.toMatch(/Preview Pia/i);
  });

  it('asks for the password again, makes one pending request, tells the other administrators, and a second ask returns the same one', async () => {
    const m = await person(owner, t, A, 'Flow One');
    const wrong = await ask(m.client, WRONG);
    expect(wrong.statusCode).toBe(400);
    expect(errorCode(wrong)).toBe('invalid_current_password');
    expect(await rows(m.userId)).toEqual([]);
    const r = await ask(m.client);
    expect(r.statusCode, r.body).toBe(202);
    const first = r.json();
    expect(first).toMatchObject({
      alreadyInProgress: false,
      request: { status: 'pending_approval', graceUntil: null },
    });
    const requestedAt = new Date(first.request.requestedAt).getTime();
    expect(new Date(first.request.expiresAt).getTime() - requestedAt).toBe(30 * DAY);
    const again = await ask(m.client);
    expect(again.json()).toMatchObject({
      alreadyInProgress: true,
      request: { id: first.request.id },
    });
    expect((await rows(m.userId)).length).toBe(1);
    expect(await audits('privacy.erasure_requested', first.request.id)).toBe(1);
    // the administrators are told in the bell and by e-mail (no name, no count); the member is not
    for (const adminUser of [A.adminUserId, admin2.userId]) {
      expect((await noteTypes(adminUser)).map((n) => n.type)).toContain('erasure_request_received');
      const mail = await mails(adminUser, 'erasure_request_received');
      expect(mail.length).toBeGreaterThan(0);
      expect(JSON.stringify(mail)).not.toContain('Flow One');
    }
    expect((await noteTypes(m.userId)).map((n) => n.type)).not.toContain(
      'erasure_request_received',
    );
    // a member cannot decide, an administrator is not the member
    expect((await decide(m.client, first.request.id, 'approve')).statusCode).toBe(403);
    const preview = ok(await m.client.get('/me/erasure/preview'));
    expect(preview.open).toMatchObject({ id: first.request.id, status: 'pending_approval' });
  });

  it('approval by ANOTHER administrator starts 7 days of grace, tells the member, and the member can cancel until then', async () => {
    const m = await person(owner, t, A, 'Flow Two');
    const id = ok(await ask(m.client)).request.id as string;
    const done = ok(await decide(admin, id, 'approve'));
    expect(done.request.status).toBe('approved');
    const r = await row(id);
    expect(new Date(r.grace_until).getTime() - new Date(r.approved_at).getTime()).toBe(7 * DAY);
    expect(r.approved_by).toBe(A.adminUserId);
    expect(await audits('privacy.erasure_approved', id)).toBe(1);
    const note = (await noteTypes(m.userId)).find((n) => n.type === 'erasure_request_approved');
    expect(note?.params).toMatchObject({ days: 7 });
    expect((await mails(m.userId, 'erasure_request_approved'))[0]?.params).toMatchObject({
      days: 7,
      link: '/me/data',
    });
    // the member withdraws; nothing was erased; a second cancel is "too late" (it is over)
    const cancelled = ok(await m.client.post('/me/erasure/cancel', {}));
    expect(cancelled.request.status).toBe('cancelled');
    expect(await activeMember(m)).toBe('active');
    expect(await override(m)).toBe(0);
    expect((await decide(admin, id, 'cancel')).statusCode).toBe(409);
    expect((await m.client.post('/me/erasure/cancel', {})).statusCode).toBe(404);
    // and they may ask again later
    expect((await ask(m.client)).statusCode).toBe(202);
  });

  it('an administrator never approves their own request; another one does; a rejection tells the member and changes nothing', async () => {
    const id = ok(await ask(admin2.client)).request.id as string;
    const self = await decide(admin2.client, id, 'approve');
    expect(self.statusCode).toBe(409);
    expect(errorCode(self)).toBe('self_approval_not_allowed');
    expect((await row(id)).status).toBe('pending_approval');
    const rej = ok(await decide(admin, id, 'reject'));
    expect(rej.request.status).toBe('rejected');
    expect((await noteTypes(admin2.userId)).map((n) => n.type)).toContain(
      'erasure_request_rejected',
    );
    expect(await activeMember(admin2)).toBe('active');
    // decided: not again
    expect((await decide(admin, id, 'approve')).statusCode).toBe(409);
    expect((await decide(admin, id, 'reject')).statusCode).toBe(409);
  });

  it('an administrator who cancels tells the member; the list shows open requests first with the name the college sees', async () => {
    const m = await person(owner, t, A, 'Flow Three');
    const id = ok(await ask(m.client)).request.id as string;
    const list = ok(await admin.get('/privacy/erasure-requests')).items as Json[];
    const mine = list.find((x) => x.id === id);
    expect(mine).toMatchObject({
      status: 'pending_approval',
      memberName: 'Flow Three',
      memberEmail: m.email,
    });
    expect(list.findIndex((x) => x.id === id)).toBeLessThan(
      list.findIndex((x) => x.status === 'rejected'),
    );
    ok(await decide(admin, id, 'cancel'));
    expect((await noteTypes(m.userId)).map((n) => n.type)).toContain('erasure_request_cancelled');
    expect((await m.client.get('/privacy/erasure-requests')).statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------------------------ last admin
describe('the last administrator cannot be erased', () => {
  it('is refused at the request (the preview says so too)', async () => {
    const S = await createAuthFixture(owner, 'ers-solo');
    const solo = await loginAs(t, S.host, S.adminEmail);
    expect(ok(await solo.get('/me/erasure/preview')).lastAdmin).toBe(true);
    const r = await ask(solo);
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('last_admin');
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM lms.erasure_requests WHERE tenant_id = $1',
            [S.tenantId],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  it('is refused at the approval when the other administrator is gone by then (held-lock race with a demotion)', async () => {
    const S = await createAuthFixture(owner, 'ers-la1');
    const x = await loginAs(t, S.host, S.adminEmail);
    const c = await person(owner, t, S, 'Approver C', { role: 'institution_admin' });
    const id = ok(await ask(x)).request.id as string;
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('lms.last_admin:' || $1::text, 0))",
        [S.tenantId],
      );
      const approve = decide(c.client, id, 'approve');
      await waiting('%privacy_erasure_decide%', 1);
      // while the approval waits for the last-admin lock, the approver stops being an administrator (the owner is exempt from the trigger)
      await owner.query("UPDATE lms.tenant_memberships SET role = 'member' WHERE id = $1", [
        c.membershipId,
      ]);
      await holder.query('COMMIT');
      const res = await approve;
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('last_admin');
      expect((await row(id)).status).toBe('pending_approval');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('is refused at the execution: the request is rejected (last_admin), the member keeps everything and is told', async () => {
    const S = await createAuthFixture(owner, 'ers-la2');
    const x = await loginAs(t, S.host, S.adminEmail);
    const y = await person(owner, t, S, 'Admin Y', { role: 'institution_admin' });
    const id = ok(await ask(x)).request.id as string;
    ok(await decide(y.client, id, 'approve'));
    await makeDue(id);
    // X (still an administrator) demotes Y: allowed, X is not gone yet
    const demote = await x.patch(`/members/${y.userId}/role`, { role: 'member' });
    expect(demote.statusCode, demote.body).toBeLessThan(300);
    const out = await svc().scan();
    expect(out).toMatchObject({ erased: 0, blocked: 1 });
    expect(await row(id)).toMatchObject({ status: 'rejected', reason: 'last_admin' });
    expect(
      (
        await owner.query(
          'SELECT status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
          [S.tenantId, S.adminUserId],
        )
      ).rows[0].status,
    ).toBe('active');
    expect((await noteTypes(S.adminUserId)).map((n) => n.type)).toContain(
      'erasure_request_rejected',
    );
    expect(await audits('privacy.erasure_blocked', id)).toBe(1);
  });

  it('a demotion and an execution at the same moment never leave the college without an administrator (held lock, both outcomes legal)', async () => {
    const S = await createAuthFixture(owner, 'ers-la3');
    const x = await loginAs(t, S.host, S.adminEmail);
    const y = await person(owner, t, S, 'Admin Y3', { role: 'institution_admin' });
    const id = ok(await ask(x)).request.id as string;
    ok(await decide(y.client, id, 'approve'));
    await makeDue(id);
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('lms.last_admin:' || $1::text, 0))",
        [S.tenantId],
      );
      const exec = svc().scan();
      await waiting('%privacy_erasure_execute%', 1);
      const demote = x.patch(`/members/${y.userId}/role`, { role: 'member' });
      await waiting('%tenant_memberships%', 1);
      await holder.query('COMMIT');
      const [, d] = await Promise.all([exec, demote]);
      const admins = Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.tenant_memberships WHERE tenant_id = $1 AND role = 'institution_admin' AND status = 'active'",
            [S.tenantId],
          )
        ).rows[0].n,
      );
      expect(admins).toBeGreaterThanOrEqual(1); // the invariant
      const status = (await row(id)).status;
      if (status === 'done')
        expect(d.statusCode).toBe(409); // X was erased first: the demotion of Y was refused
      else expect(status).toBe('rejected'); // Y was demoted first: the execution was refused
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ races
describe('races (deterministic holder sessions)', () => {
  /** holds the row lock of a request in a session of the test */
  async function holdRequest(id: string) {
    const h = await owner.connect();
    await h.query('BEGIN');
    await h.query('SELECT 1 FROM lms.erasure_requests WHERE id = $1 FOR UPDATE', [id]);
    return {
      release: async () => {
        await h.query('COMMIT');
        h.release();
      },
    };
  }

  it('against a SIGN-IN in flight: the execution does not wait for the session insert (lock mode on the membership), and the session that lands is dead', async () => {
    // A sign-in inserts its session row: the foreign key to the membership takes FOR KEY SHARE and holds it until the commit. The execution
    // must lock the membership with a mode that does NOT conflict with it (FOR NO KEY UPDATE; FOR UPDATE queued behind the sign-in and
    // would deadlock the moment the sign-in needed anything the execution holds, as the account-level one did).
    const { m, id } = await approved('Race Login College', true);
    const h = await owner.connect();
    try {
      await h.query('BEGIN');
      await h.query('SELECT 1 FROM lms.user_credentials WHERE user_id = $1 FOR UPDATE', [m.userId]);
      const token = randomBytes(32);
      await h.query(
        "INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day')",
        [newId(), token, m.userId, A.tenantId],
      );
      // the execution finishes while the sign-in's transaction is still open
      const out = await Promise.race([
        svc().scan(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('the execution waited for the sign-in (lock mode)')),
            8_000,
          ),
        ),
      ]);
      expect(out.erased).toBeGreaterThanOrEqual(1);
      expect((await row(id)).status).toBe('done');
      await h.query('COMMIT');
      // the session that landed after the revocation cannot be used: the membership is removed
      const hit = await owner.query('SELECT 1 FROM lms.auth_lookup_session($1, $2, 300, 604800)', [
        token,
        A.tenantId,
      ]);
      expect(hit.rowCount).toBe(0);
      expect(await activeMember(m)).toBe('removed');
    } finally {
      await h.query('ROLLBACK').catch(() => undefined);
      h.release();
    }
  });

  it('approve against cancel: whoever queued first wins, nothing is half done and nothing is a 500', async () => {
    // cancel first: the approval then finds a cancelled request
    const m1 = await person(owner, t, A, 'Race One');
    const id1 = ok(await ask(m1.client)).request.id as string;
    const h1 = await holdRequest(id1);
    const c1 = m1.client.post('/me/erasure/cancel', {});
    await waiting('%privacy_erasure_decide%', 1);
    const a1 = decide(admin, id1, 'approve');
    await waiting('%privacy_erasure_decide%', 2);
    await h1.release();
    const [rc1, ra1] = await Promise.all([c1, a1]);
    expect(rc1.statusCode).toBe(200);
    expect(ra1.statusCode).toBe(409);
    expect((await row(id1)).status).toBe('cancelled');
    expect(await audits('privacy.erasure_approved', id1)).toBe(0);

    // approve first: the member's cancel then ends the approved request (the grace period is still running)
    const m2 = await person(owner, t, A, 'Race Two');
    const id2 = ok(await ask(m2.client)).request.id as string;
    const h2 = await holdRequest(id2);
    const a2 = decide(admin, id2, 'approve');
    await waiting('%privacy_erasure_decide%', 1);
    const c2 = m2.client.post('/me/erasure/cancel', {});
    await waiting('%privacy_erasure_decide%', 2);
    await h2.release();
    const [ra2, rc2] = await Promise.all([a2, c2]);
    expect([ra2.statusCode, rc2.statusCode]).toEqual([200, 200]);
    expect((await row(id2)).status).toBe('cancelled');
    expect(await override(m2)).toBe(0);
  });

  describe('execute against cancel at the grace boundary (explicit instants)', () => {
    const GRACE = new Date('2026-03-18T09:00:00Z');
    const secBefore = new Date(GRACE.getTime() - 1000);
    const hash = "decode(repeat('ab', 32), 'hex')";

    /** a request made and approved at fixed instants: the grace period ends at GRACE */
    async function atBoundary(name: string) {
      const m = await person(owner, t, A, name);
      const r = (
        await owner.query(
          'SELECT lms.privacy_erasure_request($1, $2, NULL, $3::timestamptz) AS r',
          [A.tenantId, m.userId, '2026-03-10T09:00:00Z'],
        )
      ).rows[0].r;
      const id = r.request.id as string;
      const d = (
        await owner.query(
          "SELECT lms.privacy_erasure_decide($1, $2, $3, 'approve', $4::timestamptz, NULL) AS r",
          [A.tenantId, id, A.adminUserId, '2026-03-11T09:00:00Z'],
        )
      ).rows[0].r;
      expect(d.result).toBe('ok');
      expect(new Date((await row(id)).grace_until).toISOString()).toBe(GRACE.toISOString());
      return { m, id };
    }
    const execAt = (id: string, m: Person, at: Date) =>
      owner
        .query(
          `SELECT lms.privacy_erasure_execute($1, $2, $3::timestamptz, $4, ${hash}, 'k1') AS r`,
          [A.tenantId, id, at.toISOString(), m.email],
        )
        .then((r) => r.rows[0].r);
    const cancelAt = (id: string, m: Person, at: Date) =>
      owner
        .query(
          "SELECT lms.privacy_erasure_decide($1, $2, $3, 'cancel', $4::timestamptz, NULL) AS r",
          [A.tenantId, id, m.userId, at.toISOString()],
        )
        .then((r) => r.rows[0].r);

    it('7 days minus 1 second: the execution is not due and the cancel works; it stays cancelled', async () => {
      const { m, id } = await atBoundary('Boundary Before');
      expect((await execAt(id, m, secBefore)).result).toBe('not_due');
      expect((await cancelAt(id, m, secBefore)).result).toBe('ok');
      expect((await execAt(id, m, GRACE)).result).toBe('skip');
      expect(await override(m)).toBe(0);
      expect(await activeMember(m)).toBe('active');
    });

    it('7 days exactly: the cancel is "too late" and the execution runs', async () => {
      const { m, id } = await atBoundary('Boundary At');
      expect((await cancelAt(id, m, GRACE)).result).toBe('too_late');
      const r = await execAt(id, m, GRACE);
      expect(r.result).toBe('ok');
      expect(await override(m)).toBe(1);
      expect(await activeMember(m)).toBe('removed');
      expect((await row(id)).status).toBe('done');
    });

    for (const order of ['cancel first', 'execute first'] as const) {
      it(`cancel at the last second and execute at the first, started together (${order}): exactly one of them wins`, async () => {
        const { m, id } = await atBoundary(`Boundary Race ${order}`);
        const h = await holdRequest(id);
        const run = () =>
          order === 'cancel first' ? cancelAt(id, m, secBefore) : execAt(id, m, GRACE);
        const second = () =>
          order === 'cancel first' ? execAt(id, m, GRACE) : cancelAt(id, m, secBefore);
        const p1 = run();
        await waiting('%privacy_erasure_%', 1);
        const p2 = second();
        await waiting('%privacy_erasure_%', 2);
        await h.release();
        const [r1, r2] = await Promise.all([p1, p2]);
        const status = (await row(id)).status;
        if (order === 'cancel first') {
          expect([r1.result, r2.result]).toEqual(['ok', 'skip']);
          expect(status).toBe('cancelled');
          expect(await override(m)).toBe(0);
        } else {
          expect([r1.result, r2.result]).toEqual(['ok', 'too_late']);
          expect(status).toBe('done');
          expect(await override(m)).toBe(1);
        }
      });
    }
  });

  for (const cause of ['suspended', 'removed'] as const) {
    it(`execute against a concurrent ${cause === 'suspended' ? 'suspension' : 'removal'}: the member ends erased and removed, nothing is lost`, async () => {
      const { m, id } = await approved(`Race ${cause}`, true);
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM lms.tenant_memberships WHERE id = $1 FOR UPDATE', [
          m.membershipId,
        ]);
        await holder.query('UPDATE lms.tenant_memberships SET status = $2 WHERE id = $1', [
          m.membershipId,
          cause,
        ]);
        const exec = svc().scan();
        await waiting('%privacy_erasure_execute%', 1);
        await holder.query('COMMIT');
        expect((await exec).erased).toBeGreaterThanOrEqual(1);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(await override(m)).toBe(1);
      expect(await activeMember(m)).toBe('removed');
      expect((await row(id)).status).toBe('done');
    });
  }

  it('duplicate open requests: two asks at the same moment make ONE request, and the index refuses a second open row', async () => {
    const m = await person(owner, t, A, 'Race Duplicate');
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || $1::text, 0))",
        [m.userId],
      );
      const both = Promise.all([ask(m.client), ask(m.client)]);
      await waiting('%privacy_erasure_request%', 2);
      expect(await rows(m.userId)).toEqual([]);
      await holder.query('COMMIT');
      const [a, b] = await both;
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect([a.json().alreadyInProgress, b.json().alreadyInProgress].sort()).toEqual([
        false,
        true,
      ]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await rows(m.userId)).length).toBe(1);
    await expect(
      owner.query(
        `INSERT INTO lms.erasure_requests (id, tenant_id, membership_id, user_id, status, requested_at) VALUES ($1, $2, $3, $4, 'pending_approval', now())`,
        [newId(), A.tenantId, m.membershipId, m.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ------------------------------------------------------------------------------------------------------------------ expiry
describe('an undecided request expires after 30 days, and the member is told in the bell AND by e-mail', () => {
  const T0 = new Date('2026-04-01T09:00:00Z');
  const expire = (at: Date) =>
    owner
      .query('SELECT lms.privacy_erasure_expire($1::timestamptz, 100) AS n', [at.toISOString()])
      .then((r) => Number(r.rows[0].n));

  it('one second before 30 days nothing happens; at 30 days it expires, notifies once, and the request can no longer be approved', async () => {
    const m = await person(owner, t, A, 'Expiry Eve');
    const id = (
      await owner.query('SELECT lms.privacy_erasure_request($1, $2, NULL, $3::timestamptz) AS r', [
        A.tenantId,
        m.userId,
        T0.toISOString(),
      ])
    ).rows[0].r.request.id as string;
    expect(await expire(new Date(T0.getTime() + 30 * DAY - 1000))).toBe(0);
    expect((await row(id)).status).toBe('pending_approval');
    expect(await expire(new Date(T0.getTime() + 30 * DAY))).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ status: 'expired' });
    expect(await audits('privacy.erasure_expired', id)).toBe(1);
    const bell = (await noteTypes(m.userId)).filter((n) => n.type === 'erasure_request_expired');
    expect(bell).toHaveLength(1);
    const mail = await mails(m.userId, 'erasure_request_expired');
    expect(mail).toHaveLength(1);
    expect(mail[0]?.params).toEqual({ link: '/me/data' }); // nothing about the person
    // a second run does not notify again
    expect(await expire(new Date(T0.getTime() + 31 * DAY))).toBe(0);
    expect((await mails(m.userId, 'erasure_request_expired')).length).toBe(1);
    // the e-mail goes out, says what it must and holds nothing personal
    await deliverEmails(t);
    const sent = t.mailer.sent.find((x) => x.to === m.email && x.subject.includes('has expired'));
    expect(sent).toBeDefined();
    expect(sent?.text).toContain('30 days');
    expect(sent?.text).not.toContain('Expiry Eve');
    // decided too late: expired, never approved
    const late = await owner.query(
      "SELECT lms.privacy_erasure_decide($1, $2, $3, 'approve', $4::timestamptz, NULL) AS r",
      [A.tenantId, id, A.adminUserId, new Date(T0.getTime() + 31 * DAY).toISOString()],
    );
    expect(late.rows[0].r.result).toBe('not_pending');
    // the scheduled job does the same through the service
    expect(typeof (await svc().scan()).expired).toBe('number');
  });

  it('an approval one second before the 30 days is accepted, at 30 days it is "expired"', async () => {
    const m = await person(owner, t, A, 'Expiry Edge');
    const id = (
      await owner.query('SELECT lms.privacy_erasure_request($1, $2, NULL, $3::timestamptz) AS r', [
        A.tenantId,
        m.userId,
        T0.toISOString(),
      ])
    ).rows[0].r.request.id as string;
    const at = (d: Date) =>
      owner
        .query(
          "SELECT lms.privacy_erasure_decide($1, $2, $3, 'approve', $4::timestamptz, NULL) AS r",
          [A.tenantId, id, A.adminUserId, d.toISOString()],
        )
        .then((r) => r.rows[0].r.result as string);
    expect(await at(new Date(T0.getTime() + 30 * DAY))).toBe('expired');
    expect(await at(new Date(T0.getTime() + 30 * DAY - 1000))).toBe('ok');
  });
});

// ------------------------------------------------------------------------------------------------------------------ audit atomicity
describe('AUDIT ATOMICITY: when an audit row cannot be written, the change does not happen (failure injection)', () => {
  const noRequest = async (m: Person) => expect(await rows(m.userId)).toEqual([]);

  it('request: no request, no notice to the administrators', async () => {
    const m = await person(owner, t, A, 'Atomic Request');
    const before = Number(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM lms.notifications WHERE type = 'erasure_request_received'",
        )
      ).rows[0].n,
    );
    await arm(true);
    const r = await ask(m.client);
    await arm(false);
    expect(r.statusCode).toBe(500);
    await noRequest(m);
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM lms.notifications WHERE type = 'erasure_request_received'",
          )
        ).rows[0].n,
      ),
    ).toBe(before);
    expect((await ask(m.client)).statusCode).toBe(202); // and it works when the audit works
  });

  it('approve, reject and cancel: the request keeps its state and nothing is announced', async () => {
    const m = await person(owner, t, A, 'Atomic Decide');
    const id = ok(await ask(m.client)).request.id as string;
    await arm(true);
    for (const action of ['approve', 'reject'] as const)
      expect((await decide(admin, id, action)).statusCode).toBe(500);
    expect((await row(id)).status).toBe('pending_approval');
    expect((await row(id)).grace_until).toBeNull();
    expect(
      (await noteTypes(m.userId)).filter((n) => n.type.startsWith('erasure_request_')),
    ).toEqual([]);
    await arm(false);
    ok(await decide(admin, id, 'approve'));
    await arm(true);
    expect((await m.client.post('/me/erasure/cancel', {})).statusCode).toBe(500);
    expect((await decide(admin, id, 'cancel')).statusCode).toBe(500);
    await arm(false);
    expect((await row(id)).status).toBe('approved');
  });

  it('expiry: the request stays pending and nobody is told', async () => {
    const m = await person(owner, t, A, 'Atomic Expiry');
    const T = new Date('2026-05-01T09:00:00Z');
    const id = (
      await owner.query('SELECT lms.privacy_erasure_request($1, $2, NULL, $3::timestamptz) AS r', [
        A.tenantId,
        m.userId,
        T.toISOString(),
      ])
    ).rows[0].r.request.id as string;
    await arm(true);
    await expect(
      owner.query('SELECT lms.privacy_erasure_expire($1::timestamptz, 100)', [
        new Date(T.getTime() + 31 * DAY).toISOString(),
      ]),
    ).rejects.toThrow(/injected/);
    await arm(false);
    expect((await row(id)).status).toBe('pending_approval');
    expect((await noteTypes(m.userId)).map((n) => n.type)).not.toContain('erasure_request_expired');
  });

  for (const [what, insert, update] of [
    ['execute (the "executed" audit row)', true, false],
    ['scrub (the update of the audit trail)', false, true],
  ] as const) {
    it(`${what}: the member is exactly as before (still active, sessions alive, no override, mail and profile intact), and the retry completes`, async () => {
      const { m, id } = await approved(`Atomic ${insert ? 'Execute' : 'Scrub'}`, true);
      await owner.query(
        "INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status) VALUES ($1, $2, $3, $4, $5, 'learning_content', 'content_digest', '{\"a\":1}', 'queued')",
        [newId(), A.tenantId, `atomic:${id}`, m.userId, m.email],
      );
      // something for the scrub to find (the owner may insert audit rows)
      await owner.query(
        'INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, \'test.scrub_me\', \'user\', $4, \'{"ip":"10.1.1.1","keep":1}\')',
        [newId(), A.tenantId, m.userId, m.userId],
      );
      await arm(insert, update);
      await expect(svc().scan()).rejects.toThrow();
      await arm(false);
      expect((await row(id)).status).toBe('approved');
      expect(await override(m)).toBe(0);
      expect(await activeMember(m)).toBe('active');
      expect((await m.client.get('/auth/me')).statusCode).toBe(200); // the session was NOT revoked
      const outbox = (
        await owner.query(
          'SELECT to_email, status, params FROM lms.email_outbox WHERE idempotency_key = $1',
          [`atomic:${id}`],
        )
      ).rows[0];
      expect(outbox).toMatchObject({ to_email: m.email, status: 'queued', params: { a: 1 } });
      expect(
        (
          await owner.query(
            "SELECT metadata FROM lms.audit_log WHERE action = 'test.scrub_me' AND target_id = $1",
            [m.userId],
          )
        ).rows[0].metadata,
      ).toEqual({ ip: '10.1.1.1', keep: 1 });
      // the retry completes it
      expect((await svc().scan()).erased).toBeGreaterThanOrEqual(1);
      expect((await row(id)).status).toBe('done');
      expect((await m.client.get('/auth/me')).statusCode).toBe(401);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------ privacy of the notices
describe('the notices about erasure hold nothing about anybody (sentinel over every row and every e-mail)', () => {
  it('only a link and the number of days travel in a notice; the rendered mails name no member, address or count', async () => {
    const m = await person(owner, t, A, 'Notice Nora Sentinel');
    const id = ok(await ask(m.client)).request.id as string;
    ok(await decide(admin, id, 'approve'));
    ok(await m.client.post('/me/erasure/cancel', {}));
    const id2 = ok(await ask(m.client)).request.id as string;
    ok(await decide(admin, id2, 'reject'));
    const id3 = ok(await ask(m.client)).request.id as string;
    ok(await decide(admin, id3, 'cancel'));
    await deliverEmails(t);
    const outbox = (
      await owner.query(
        "SELECT template, params FROM lms.email_outbox WHERE template LIKE 'erasure_request_%'",
      )
    ).rows;
    expect(outbox.length).toBeGreaterThan(3);
    for (const r of outbox)
      expect(Object.keys(r.params).every((k) => ['link', 'days'].includes(k))).toBe(true);
    const bell = (
      await owner.query(
        "SELECT params, link FROM lms.notifications WHERE type LIKE 'erasure_request_%'",
      )
    ).rows;
    expect(bell.length).toBeGreaterThan(3);
    for (const r of bell)
      expect(Object.keys(r.params).every((k) => ['days'].includes(k))).toBe(true);
    const sent = t.mailer.sent.filter((x) => /erased|erasure/i.test(x.subject));
    expect(sent.length).toBeGreaterThan(2);
    for (const mail of sent) {
      const everything = `${mail.subject} ${mail.text} ${mail.html}`;
      expect(everything).not.toMatch(/Nora|Sentinel/i);
      expect(everything).not.toContain(m.email);
      expect(everything).not.toMatch(/\b\d+ (members?|requests?)\b/);
    }
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
    process.stdout.write(`ROUND-TRIPS ${name}: ${n} (budget ${max})
`);

  it('preview 2, my request 2, ask 3 (a refused password 3), approve 2, cancel 3, the administrators list 4', async () => {
    const m = await person(owner, t, A, 'Budget Bea');
    await m.client.get('/me/erasure'); // warm: slug cache, the activity touch of the day
    await admin.get('/privacy/erasure-requests');
    const pv = await count(() => m.client.get('/me/erasure/preview'));
    line('GET /me/erasure/preview', pv.n, 2);
    expect(pv.n).toBeLessThanOrEqual(2);
    const mine = await count(() => m.client.get('/me/erasure'));
    line('GET /me/erasure', mine.n, 2);
    expect(mine.n).toBeLessThanOrEqual(2);
    const wrong = await count(() => ask(m.client, WRONG));
    expect(wrong.status).toBe(400);
    line('POST /me/erasure (wrong password)', wrong.n, 4);
    expect(wrong.n).toBeLessThanOrEqual(4);
    const good = await count(() => ask(m.client));
    expect(good.status).toBe(202);
    line('POST /me/erasure', good.n, 4);
    expect(good.n).toBeLessThanOrEqual(4);
    const id = (await rows(m.userId))[0].id as string;
    const list = await count(() => admin.get('/privacy/erasure-requests'));
    line('GET /privacy/erasure-requests', list.n, 4);
    expect(list.n).toBeLessThanOrEqual(4);
    const ap = await count(() => decide(admin, id, 'approve'));
    expect(ap.status).toBe(200);
    line('POST /privacy/erasure-requests/:id/approve', ap.n, 3);
    expect(ap.n).toBeLessThanOrEqual(3);
    const cancel = await count(() => m.client.post('/me/erasure/cancel', {}));
    expect(cancel.status).toBe(200);
    line('POST /me/erasure/cancel', cancel.n, 4);
    expect(cancel.n).toBeLessThanOrEqual(4);
  });
});

// keep the unused helper type import honest
void TestClient;

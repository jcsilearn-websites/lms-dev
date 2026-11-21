// biome-ignore-all lint/style/noNonNullAssertion: test fixtures: the arrays hold what the setup just created
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { makeApp, type TestApp } from './app';
import { addAssignment, exam, rubricInput } from './assignments-helpers';
import { lastTokenFor, TestClient } from './client';
import { errorCode, ok, structure } from './courses-helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  TEST_PASSWORD,
  testOwnerPool,
} from './support';

// CLASS B: check, then act, with a different snapshot in between (CI found assessment_start: "no attempts left" when two starts
// overlapped). Every function and service found by the sweep that decided from a read and then wrote has a test here.
//
// THE TECHNIQUE (deterministic, no sleeps in the code under test): the "other transaction" is a session of the test that HOLDS what the
// code under test needs (an uncommitted row, a row lock, the advisory lock). The code under test is started and the test waits until
// PostgreSQL reports that it is BLOCKED (pg_stat_activity wait_event_type = 'Lock'): its check has been made, its act is waiting. Then the
// other transaction commits and the code under test continues. With the old code the call either was never blocked (no lock to wait for:
// `blocked()` throws) or continued on its stale check and failed or did the wrong thing; with the fix it re-checks and the assertions hold.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool(8);
  t = makeApp({ env: { TENANT_CACHE_TTL_MS: '3600000' } });
  A = await createAuthFixture(owner, 'race-a');
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

const client = () => new TestClient(t, A.host);
const adminClient = async () => {
  const c = client();
  expect((await c.login(A.adminEmail, TEST_PASSWORD)).statusCode).toBe(200);
  return c;
};

/** Waits until a statement matching `like` is blocked on a lock (the code under test has made its check and is waiting to act). */
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
  throw new Error(
    `nothing matching ${like} was blocked on a lock: the code did not wait for the other transaction`,
  );
}

const holding = new Set<pg.PoolClient>();
/** A session of the test holding a transaction open (rolled back after the test if it was not committed). */
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
  for (const c of holding) {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  holding.clear();
});

describe('auth_accept_invite: an accept never undoes a suspension made at the same moment', () => {
  it('a member suspended while the accept is in flight stays suspended, and the token is not consumed', async () => {
    const admin = await adminClient();
    const email = 'accept-race@race-a.test';
    expect(
      (await admin.post('/auth/invites', { email, role: 'member', displayName: 'Racer' }))
        .statusCode,
    ).toBe(201);
    const token = await lastTokenFor(t, email);
    const userId = (await owner.query('SELECT id FROM lms.users WHERE email = $1', [email])).rows[0]
      .id;

    const other = await hold();
    await other.q(
      `UPDATE lms.tenant_memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`,
      [A.tenantId, userId],
    ); // the admin's suspension, not committed yet: the accept still SEES a pending member
    const accept = client().post('/auth/invites/accept', {
      token,
      password: 'racer chooses a passphrase',
    });
    await blocked('%auth_accept_invite%');
    await other.commit();
    const res = await accept;

    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('invalid_or_expired_token');
    const m = await owner.query(
      'SELECT status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, userId],
    );
    expect(m.rows[0].status).toBe('suspended'); // the old code wrote 'active' here
    expect(
      (await owner.query('SELECT 1 FROM lms.user_credentials WHERE user_id = $1', [userId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await owner.query(
          `SELECT used_at FROM lms.auth_tokens WHERE user_id = $1 AND purpose = 'invite'`,
          [userId],
        )
      ).rows[0].used_at,
    ).toBeNull();
  });
});

describe('auth_login_complete: a lock set while the password was being checked is honoured', () => {
  it('denies the session when failures locked the account between the first read and the session', async () => {
    const user = (
      await owner.query(
        `INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'lockrace@race-a.test', 'Lock') RETURNING id`,
        [newId()],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
      [newId(), A.tenantId, user],
    );
    await owner.query(
      `INSERT INTO lms.user_credentials (user_id, password_hash) VALUES ($1, 'x')`,
      [user],
    );

    const other = await hold();
    // a concurrent wrong guess has just recorded the lock; not committed yet
    await other.q(
      `UPDATE lms.user_credentials SET failed_attempts = 5, locked_until = now() + interval '10 minutes' WHERE user_id = $1`,
      [user],
    );
    const complete = owner.query(
      `SELECT r_status FROM lms.auth_login_complete($1, $2, $3, $4, 600, 3600, NULL, 'ua', $5)`,
      [user, A.tenantId, newId(), Buffer.alloc(32, 7), newId()],
    );
    await blocked('%auth_login_complete%');
    await other.commit();

    expect((await complete).rows[0].r_status).toBe('denied');
    expect(
      (await owner.query('SELECT 1 FROM lms.sessions WHERE user_id = $1', [user])).rowCount,
    ).toBe(0);
  });
});

describe('platform_admin_invite: two first invites of the same person', () => {
  it('the second one finds the membership the first created instead of failing on the unique key', async () => {
    const root = await createPlatformAdmin(owner, 'root@race-a.test');
    const email = 'twice@race-a.test';
    const user = (
      await owner.query(
        `INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Twice') RETURNING id`,
        [newId(), email],
      )
    ).rows[0].id;

    const other = await hold();
    // the first invite's membership, not committed yet
    await other.q(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'pending')`,
      [newId(), A.tenantId, user],
    );
    const second = owner.query(
      `SELECT r_status, r_membership_id FROM lms.platform_admin_invite($1, $2, $3, $4, 'Twice', $5, $6, $7, 600, $8, NULL)`,
      [root.userId, A.tenantId, newId(), email, newId(), newId(), Buffer.alloc(32, 9), newId()],
    );
    await blocked('%platform_admin_invite%');
    await other.commit();

    const r = (await second).rows[0]; // the old function raised a unique violation here
    expect(r.r_status).toBe('invited');
    const m = await owner.query(
      'SELECT id, role, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, user],
    );
    expect(m.rowCount).toBe(1);
    expect(m.rows[0]).toMatchObject({
      id: r.r_membership_id,
      role: 'institution_admin',
      status: 'pending',
    });
  });
});

describe('POST /auth/invites: two invites of the same person at once', () => {
  it('the second request reuses the pending membership (201) instead of failing on the unique key (500)', async () => {
    const email = 'inv-race@race-a.test';
    const user = (
      await owner.query(
        `INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, 'Inv') RETURNING id`,
        [newId(), email],
      )
    ).rows[0].id;
    const admin = await adminClient();

    const other = await hold();
    await other.q(
      `INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'pending')`,
      [newId(), A.tenantId, user],
    ); // the first request's membership, not committed yet
    const second = admin.post('/auth/invites', { email, role: 'institution_admin' });
    await blocked('%tenant_memberships%');
    await other.commit();

    const res = await second;
    expect(res.statusCode, res.body).toBe(201);
    const m = await owner.query(
      'SELECT role, status FROM lms.tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [A.tenantId, user],
    );
    expect(m.rows).toEqual([{ role: 'institution_admin', status: 'pending' }]);
    // the audit row of the second invite is there too (one transaction)
    expect(
      (
        await owner.query(
          `SELECT 1 FROM lms.audit_log WHERE tenant_id = $1 AND action = 'auth.invite_created' AND metadata ->> 'role' = 'institution_admin'`,
          [A.tenantId],
        )
      ).rowCount,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('settings PATCH: read, merge, write is one admin at a time', () => {
  const lockKey = `tenant_settings:${'$TENANT'}`;
  const takeLock = (h: { q: (s: string, p?: unknown[]) => Promise<unknown> }) =>
    h.q(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 12))`, [
      lockKey.replace('$TENANT', A.tenantId),
    ]);
  const put = (key: string, value: unknown) =>
    owner.query(
      `INSERT INTO lms.tenant_settings (id, tenant_id, key, value) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [newId(), A.tenantId, key, JSON.stringify(value)],
    );

  it('analytics: the second admin waits for the first and merges into what the first wrote', async () => {
    const admin = await adminClient();
    const other = await hold(); // "the first admin", inside their read-merge-write
    await takeLock(other);
    const patch = admin.patch('/analytics/settings', { courseHealthWeeks: 7 });
    await blocked('%pg_advisory_xact_lock%');
    // the first admin's write, then they commit: the second must read THIS, not the state from before
    await put('analytics', {
      showCourseHealth: false,
      courseHealthWeeks: 3,
      courseHealthBacklogDays: 21,
    });
    await other.commit();
    const res = await patch;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      showCourseHealth: false, // the first admin's change survived the second's merge
      courseHealthWeeks: 7,
      courseHealthBacklogDays: 21,
    });
  });

  it('notifications: the same', async () => {
    const admin = await adminClient();
    const other = await hold();
    await takeLock(other);
    const patch = admin.patch('/notifications/settings', { digestHour: 9 });
    await blocked('%pg_advisory_xact_lock%');
    await put('notifications', { fromName: 'Written First' });
    await other.commit();
    const res = await patch;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ fromName: 'Written First', digestHour: 9 });
  });
});

describe('rubric edit: two simultaneous edits get consecutive version numbers', () => {
  it('the edit that lost the race retries and becomes version 3 (it used to fail on the unique key: 500)', async () => {
    const admin = await adminClient();
    const st = await structure(admin);
    const e = await exam(owner, t, A, admin, st, 1);
    const c = e.instructor.client;
    const r1 = ok(await c.post(`/courses/${e.courseId}/rubrics`, rubricInput('race')));

    const other = await hold();
    // the competing edit holds the rubric row: our statement takes its snapshot (version 1 is the latest) and then waits for the lock
    await other.q('SELECT 1 FROM lms.rubrics WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
      A.tenantId,
      r1.id,
    ]);
    const edit = c.put(`/courses/${e.courseId}/rubrics/${r1.id}`, rubricInput('race edited by us'));
    await blocked('%'); // the statement text is cut at 1 kB by pg_stat_activity: the lock wait is the marker
    // ... and the competing edit commits version 2 before ours continues
    const v1 = (
      await owner.query(
        'SELECT criteria, max_points, created_by FROM lms.rubric_versions WHERE rubric_id = $1',
        [r1.id],
      )
    ).rows[0];
    const v2 = newId();
    await other.q(
      `INSERT INTO lms.rubric_versions (id, tenant_id, rubric_id, version_no, criteria, max_points, created_by)
       VALUES ($1, $2, $3, 2, $4::jsonb, $5, $6)`,
      [v2, A.tenantId, r1.id, JSON.stringify(v1.criteria), v1.max_points, v1.created_by],
    );
    await other.q('UPDATE lms.rubrics SET current_version_id = $1 WHERE id = $2', [v2, r1.id]);
    await other.commit();

    const res = await edit;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().versionNo).toBe(3);
    expect(
      (
        await owner.query(
          'SELECT version_no FROM lms.rubric_versions WHERE rubric_id = $1 ORDER BY 1',
          [r1.id],
        )
      ).rows.map((x) => x.version_no),
    ).toEqual([1, 2, 3]);
  });
});

describe('assignment_upload_begin: serialised with the hand-in of the same learner', () => {
  it('waits for the learner’s lock and decides from what the other writer committed', async () => {
    const admin = await adminClient();
    const st = await structure(admin);
    const e = await exam(owner, t, A, admin, st, 1);
    const item = await addAssignment(e, { settings: { allowFile: true, maxFiles: 3 } });
    const learner = e.learners[0]!;
    const participant = (
      await owner.query(
        `SELECT cp.id FROM lms.course_participants cp JOIN lms.tenant_memberships tm ON tm.id = cp.membership_id AND tm.tenant_id = cp.tenant_id
          WHERE cp.tenant_id = $1 AND cp.offering_id = $2 AND tm.user_id = $3`,
        [A.tenantId, e.offeringId, learner.userId],
      )
    ).rows[0].id;

    const other = await hold(); // "the hand-in": holds the learner's key, as assignment_submit does
    await other.q('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 10))', [
      item.id + participant,
    ]);
    const begin = owner.query(
      `SELECT lms.assignment_upload_begin($1, $2, $3, $4, $5, $6, 'a.pdf', 'application/pdf', 100, 600) AS r`,
      [A.tenantId, learner.userId, e.offeringId, item.id, newId(), `k/${newId()}`],
    );
    await blocked('%assignment_upload_begin%');
    // the other writer changes the rule while this call waits: files are not allowed any more
    await other.q(
      'UPDATE lms.assignments SET allow_file = false, allow_text = true WHERE tenant_id = $1 AND item_id = $2',
      [A.tenantId, item.id],
    );
    await other.commit();

    expect((await begin).rows[0].r).toMatchObject({ result: 'files_not_allowed' });
    expect(
      (
        await owner.query('SELECT 1 FROM lms.assignment_uploads WHERE assignment_item_id = $1', [
          item.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
});

describe('the lock-handoff helper itself', () => {
  it('reports "never blocked" instead of passing silently', async () => {
    await expect(blocked('%a statement that never runs%', 150)).rejects.toThrow(/did not wait/);
  });
});

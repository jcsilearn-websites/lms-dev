import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import { expectPgError, SQLSTATE } from './helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  testAppDbOptions,
  testAppPool,
  testOwnerPool,
} from './support';

let owner: pg.Pool;
let app: pg.Pool;
let db: Database;
let A: AuthFixture;
let B: AuthFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  db = createDb(testAppDbOptions(2));
  A = await createAuthFixture(owner, 'fn-a');
  B = await createAuthFixture(owner, 'fn-b');
});

afterAll(async () => {
  await db.close();
  await app.end();
  await owner.end();
});

const AUTH_FUNCTIONS = [
  'auth_resolve_tenant',
  'auth_find_login',
  'auth_record_login_failure',
  'auth_clear_failures',
  'auth_set_password',
  'auth_lookup_session',
  'auth_revoke_user_sessions',
  'auth_ensure_user',
  'auth_create_token',
  'auth_consume_reset_token',
  'auth_accept_invite',
  'auth_audit_platform',
  'auth_login_begin',
  'auth_login_complete',
  'auth_login_failed',
  'auth_logout',
  'auth_reset_password',
  'auth_change_password',
  'auth_purge_sessions',
  'auth_purge_tokens',
];

describe('lms_app has no direct access to credential, token and platform-audit tables', () => {
  it('cannot SELECT, INSERT, UPDATE or DELETE user_credentials', async () => {
    await expectPgError(
      app.query('SELECT * FROM lms.user_credentials'),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query(
        "INSERT INTO lms.user_credentials (user_id, password_hash) VALUES (gen_random_uuid(), 'x')",
      ),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query("UPDATE lms.user_credentials SET password_hash = 'x'"),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query('DELETE FROM lms.user_credentials'),
      SQLSTATE.insufficientPrivilege,
    );
    // not even the hash column, not even through withTenant
    await expectPgError(
      db.withTenant(A.tenantId, (tx) =>
        tx.execute(sql.raw('select password_hash from lms.user_credentials')),
      ),
      SQLSTATE.insufficientPrivilege,
    );
  });

  it('cannot touch auth_tokens or platform_audit_log, and cannot DELETE sessions', async () => {
    await expectPgError(app.query('SELECT * FROM lms.auth_tokens'), SQLSTATE.insufficientPrivilege);
    await expectPgError(
      app.query('SELECT * FROM lms.platform_audit_log'),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query(
        "INSERT INTO lms.platform_audit_log (id, action, target_type) VALUES (gen_random_uuid(), 'x', 'y')",
      ),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(app.query('DELETE FROM lms.sessions'), SQLSTATE.insufficientPrivilege);
    await expectPgError(
      app.query('UPDATE lms.sessions SET user_id = user_id'),
      SQLSTATE.insufficientPrivilege,
    );
  });
});

describe('SECURITY DEFINER functions are hardened', () => {
  it('every auth_* function is SECURITY DEFINER, owner-owned, with a pinned search_path', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig AS config
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'auth\\_%'`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...AUTH_FUNCTIONS].sort());
    const me = await owner.query<{ current_user: string }>('SELECT current_user');
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(me.rows[0]?.current_user);
      expect(r.owner, r.proname).not.toBe('lms_app');
      expect(r.config, r.proname).toContain('search_path=lms, pg_temp');
    }
  });

  it('EXECUTE is granted to lms_app only: not PUBLIC, not anon/authenticated', async () => {
    const { rows } = await owner.query<{ proname: string; grantees: string[] }>(
      `SELECT p.proname,
              COALESCE(array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), '{}') AS grantees
       FROM pg_proc p
       LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'auth\\_%'
       GROUP BY p.proname`,
    );
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    for (const r of rows) {
      expect(r.grantees, r.proname).toContain('lms_app');
      expect(r.grantees, r.proname).not.toContain('PUBLIC');
      expect(r.grantees, r.proname).not.toContain('anon');
      expect(r.grantees, r.proname).not.toContain('authenticated');
      for (const g of r.grantees) expect([me, 'lms_app'], `${r.proname} -> ${g}`).toContain(g);
    }
  });

  it('return only the documented columns', async () => {
    const cols = async (sql: string) => {
      const res = await app.query(sql);
      return res.fields.map((f) => f.name);
    };
    expect(await cols("SELECT * FROM lms.auth_resolve_tenant('fn-a')")).toEqual([
      'id',
      'slug',
      'status',
    ]);
    expect(await cols("SELECT * FROM lms.auth_find_login('x@y.zz')")).toEqual([
      'user_id',
      'password_hash',
      'locked_until',
      'is_platform_admin',
    ]);
    expect(
      await cols(
        "SELECT * FROM lms.auth_lookup_session(decode(repeat('00', 32), 'hex'), NULL, 300, 60)",
      ),
    ).toEqual([
      'session_id',
      'user_id',
      'tenant_id',
      'membership_role',
      'is_platform_admin',
      'email',
      'display_name',
    ]);
    expect(
      await cols("SELECT * FROM lms.auth_consume_reset_token(decode(repeat('00', 32), 'hex'))"),
    ).toEqual(['user_id']);
  });

  it('tenant resolution returns id, slug and status for a slug and nothing for an unknown one', async () => {
    const found = await app.query("SELECT * FROM lms.auth_resolve_tenant('fn-a')");
    expect(found.rows).toEqual([{ id: A.tenantId, slug: 'fn-a', status: 'active' }]);
    expect((await app.query("SELECT * FROM lms.auth_resolve_tenant('nope')")).rowCount).toBe(0);
    expect(
      (await app.query('SELECT * FROM lms.auth_resolve_tenant($1)', ["fn-a' OR '1'='1"])).rowCount,
    ).toBe(0);
  });

  it('cannot be hijacked through search_path or temp objects', async () => {
    const client = await app.connect();
    try {
      // an attacker-controlled temp table shadowing lms tables, and a hostile search_path
      await client.query(
        'CREATE TEMP TABLE users (id uuid, email text, is_platform_admin boolean)',
      );
      await client.query(
        "INSERT INTO users VALUES (gen_random_uuid(), 'attacker@evil.test', true)",
      );
      await client.query('CREATE TEMP TABLE user_credentials (user_id uuid, password_hash text)');
      await client.query('SET search_path = pg_temp, public');
      const fake = await client.query("SELECT * FROM lms.auth_find_login('attacker@evil.test')");
      expect(fake.rowCount).toBe(0); // the function reads lms.users, not the temp table
      const real = await client.query('SELECT * FROM lms.auth_find_login($1)', [A.memberEmail]);
      expect(real.rowCount).toBe(1);
      expect(real.rows[0].user_id).toBe(A.memberUserId);
      // a temp function named like a built-in does not get called either
      await client.query(
        "CREATE FUNCTION pg_temp.lower(text) RETURNS text LANGUAGE sql AS $$ SELECT 'hijacked' $$",
      );
      const again = await client.query('SELECT * FROM lms.auth_find_login($1)', [
        A.memberEmail.toUpperCase(),
      ]);
      expect(again.rowCount).toBe(1);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release(true); // drop the connection (temp objects die with it)
    }
  });

  it('login lookup returns nothing for users without credentials and normalizes the email', async () => {
    const noCreds = newId();
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'nocreds@fn.test', 'N')",
      [noCreds],
    );
    expect((await app.query("SELECT * FROM lms.auth_find_login('nocreds@fn.test')")).rowCount).toBe(
      0,
    );
    const spaced = await app.query('SELECT user_id FROM lms.auth_find_login($1)', [
      `  ${A.memberEmail.toUpperCase()} `,
    ]);
    expect(spaced.rows[0]?.user_id).toBe(A.memberUserId);
  });

  it('failure counting is capped, ignores locked accounts, and the unlock/set-password functions reset it', async () => {
    const userId = A.memberUserId;
    const fail = async () =>
      (await app.query('SELECT * FROM lms.auth_record_login_failure($1, 2, 60, 900)', [userId]))
        .rows[0];
    expect((await fail()).failed_attempts).toBe(1);
    const locked = await fail();
    expect(locked.failed_attempts).toBe(2);
    expect(locked.just_locked).toBe(true);
    expect(new Date(locked.locked_until).getTime()).toBeGreaterThan(Date.now());
    const ignored = await fail(); // already locked: not counted again
    expect(ignored.failed_attempts).toBe(2);
    expect(ignored.just_locked).toBe(false);
    await app.query('SELECT lms.auth_clear_failures($1)', [userId]);
    const row = await owner.query(
      'SELECT failed_attempts, locked_until FROM lms.user_credentials WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
  });
});

describe('sessions and the plain user_id foreign key', () => {
  const tokenHash = () =>
    Buffer.from(newId().replaceAll('-', '').padEnd(64, '0'), 'hex').subarray(0, 32);
  const sessionRow = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    token_hash: Buffer.concat([
      Buffer.from(newId().replaceAll('-', ''), 'hex'),
      Buffer.from(newId().replaceAll('-', ''), 'hex'),
    ]),
    user_id: A.memberUserId,
    tenant_id: A.tenantId as string | null,
    ...over,
  });
  const insert = (r: ReturnType<typeof sessionRow>) =>
    owner.query(
      `INSERT INTO lms.sessions (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '2 days')`,
      [r.id, r.token_hash, r.user_id, r.tenant_id],
    );
  void tokenHash;

  it('a platform session (tenant_id NULL) cannot reference a user that does not exist', async () => {
    await expectPgError(
      insert(sessionRow({ tenant_id: null, user_id: newId() })),
      SQLSTATE.foreignKeyViolation,
    );
    const root = await createPlatformAdmin(owner, 'fn-root@platform.test');
    await insert(sessionRow({ tenant_id: null, user_id: root.userId })); // a real user is fine
  });

  it('a tenant session must belong to a member of that tenant', async () => {
    // member of A, but claiming tenant B
    await expectPgError(
      insert(sessionRow({ tenant_id: B.tenantId })),
      SQLSTATE.foreignKeyViolation,
    );
    await insert(sessionRow()); // member of A in A is fine
  });

  it('deleting a user or a membership removes their sessions', async () => {
    const victim = newId();
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'victim@fn.test', 'V')",
      [victim],
    );
    const mem = newId();
    await owner.query(
      'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id) VALUES ($1, $2, $3)',
      [mem, A.tenantId, victim],
    );
    const s1 = sessionRow({ user_id: victim });
    const s2 = sessionRow({ user_id: victim, tenant_id: null });
    await insert(s1);
    await insert(s2);
    await owner.query('DELETE FROM lms.tenant_memberships WHERE id = $1', [mem]);
    expect((await owner.query('SELECT 1 FROM lms.sessions WHERE id = $1', [s1.id])).rowCount).toBe(
      0,
    );
    await owner.query('DELETE FROM lms.users WHERE id = $1', [victim]);
    expect((await owner.query('SELECT 1 FROM lms.sessions WHERE id = $1', [s2.id])).rowCount).toBe(
      0,
    );
  });

  it('RLS: a user sees only their own sessions in their own tenant context', async () => {
    const mine = sessionRow();
    const theirs = sessionRow({ user_id: A.adminUserId });
    const otherTenant = sessionRow({ user_id: B.memberUserId, tenant_id: B.tenantId });
    for (const r of [mine, theirs, otherTenant]) await insert(r);

    const ids = async (tenantId: string, userId: string) =>
      (
        await db.withTenant(tenantId, (tx) => tx.execute(sql.raw('select id from lms.sessions')), {
          userId,
        })
      ).rows.map((r) => (r as { id: string }).id);

    const seenByMember = await ids(A.tenantId, A.memberUserId);
    expect(seenByMember).toContain(mine.id);
    expect(seenByMember).not.toContain(theirs.id);
    expect(seenByMember).not.toContain(otherTenant.id);
    // same user, wrong tenant context, or no user context: nothing
    expect(await ids(B.tenantId, A.memberUserId)).not.toContain(mine.id);
    const noUser = await db.withTenant(A.tenantId, (tx) =>
      tx.execute(sql.raw('select id from lms.sessions')),
    );
    expect(noUser.rows).toHaveLength(0);
    const noTenant = await app.query('SELECT id FROM lms.sessions');
    expect(noTenant.rowCount).toBe(0);
  });

  it('auth_lookup_session honours tenant binding, revocation, expiry and tenant status in ONE call', async () => {
    const S = await createAuthFixture(owner, 'fn-lookup');
    const row = sessionRow({ user_id: S.memberUserId, tenant_id: S.tenantId });
    await insert(row);
    const lookup = (tenant: string | null) =>
      app.query('SELECT * FROM lms.auth_lookup_session($1, $2, 300, 3600)', [
        row.token_hash,
        tenant,
      ]);

    const ok = await lookup(S.tenantId);
    expect(ok.rows[0]).toMatchObject({
      session_id: row.id,
      user_id: S.memberUserId,
      membership_role: 'member',
      is_platform_admin: false,
    });
    expect((await lookup(A.tenantId)).rowCount).toBe(0); // wrong tenant
    expect((await lookup(null)).rowCount).toBe(0); // admin host

    await owner.query("UPDATE lms.tenant_memberships SET status = 'pending' WHERE id = $1", [
      S.memberMembershipId,
    ]);
    expect((await lookup(S.tenantId)).rowCount).toBe(0); // membership must be active
    await owner.query("UPDATE lms.tenant_memberships SET status = 'active' WHERE id = $1", [
      S.memberMembershipId,
    ]);
    expect((await lookup(S.tenantId)).rowCount).toBe(1);

    await owner.query("UPDATE lms.tenants SET status = 'suspended' WHERE id = $1", [S.tenantId]);
    expect((await lookup(S.tenantId)).rowCount).toBe(0); // tenant must be active
    await owner.query("UPDATE lms.tenants SET status = 'active' WHERE id = $1", [S.tenantId]);

    await owner.query(
      "UPDATE lms.sessions SET last_seen_at = now() - interval '1 hour', idle_expires_at = now() + interval '1 minute' WHERE id = $1",
      [row.id],
    );
    await lookup(S.tenantId); // touch: last_seen refreshed and idle expiry slid forward
    const touched = await owner.query(
      "SELECT last_seen_at > now() - interval '10 seconds' AS fresh, idle_expires_at > now() + interval '30 minutes' AS slid FROM lms.sessions WHERE id = $1",
      [row.id],
    );
    expect(touched.rows[0]).toEqual({ fresh: true, slid: true });

    // not touched again within the window (at most one write per 5 minutes)
    const before = (
      await owner.query('SELECT last_seen_at FROM lms.sessions WHERE id = $1', [row.id])
    ).rows[0].last_seen_at;
    await lookup(S.tenantId);
    const afterRow = (
      await owner.query('SELECT last_seen_at FROM lms.sessions WHERE id = $1', [row.id])
    ).rows[0].last_seen_at;
    expect(afterRow).toEqual(before);

    await owner.query('UPDATE lms.sessions SET revoked_at = now() WHERE id = $1', [row.id]);
    expect((await lookup(S.tenantId)).rowCount).toBe(0);
  });
});

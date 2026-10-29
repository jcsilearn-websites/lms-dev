import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError, SQLSTATE } from './helpers';
import {
  type AuthFixture,
  createAuthFixture,
  createPlatformAdmin,
  testAppPool,
  testOwnerPool,
} from './support';

// The platform_* SECURITY DEFINER functions (migration 0009) and the trigger functions of 0008 get the
// same treatment as auth.functions.test.ts: hardening, grants, narrow columns, hijack resistance, and
// "the actor must be a platform admin" enforced inside the function itself.

let owner: pg.Pool;
let app: pg.Pool;
let A: AuthFixture;
let root: { userId: string; email: string };

beforeAll(async () => {
  owner = testOwnerPool();
  app = testAppPool();
  A = await createAuthFixture(owner, 'pf-a');
  root = await createPlatformAdmin(owner, 'root@pf.test');
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

const PLATFORM_FUNCTIONS = [
  'platform_admin_invite',
  'platform_create_tenant',
  'platform_get_tenant',
  'platform_list_audit',
  'platform_list_audit_v2',
  'platform_list_tenants',
  'platform_set_tenant_status',
  'platform_update_tenant',
];

describe('platform_* functions are hardened', () => {
  it('are SECURITY DEFINER, owner-owned, with a pinned search_path', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig AS config
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'platform\\_%'`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...PLATFORM_FUNCTIONS].sort());
    const me = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.owner, r.proname).toBe(me);
      expect(r.config, r.proname).toContain('search_path=lms, pg_temp');
    }
  });

  it('EXECUTE is granted to lms_app only (not PUBLIC / anon / authenticated)', async () => {
    const { rows } = await owner.query<{ proname: string; grantees: string[] }>(
      `SELECT p.proname,
              COALESCE(array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), '{}') AS grantees
       FROM pg_proc p
       LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
       WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'platform\\_%'
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

  it('the trigger functions that read across tenants are SECURITY DEFINER with a pinned search_path; none is callable by PUBLIC', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      config: string[] | null;
      public_exec: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
       FROM pg_proc p
       WHERE p.pronamespace = 'lms'::regnamespace
         AND p.proname IN ('guard_last_admin', 'guard_tenant_slug', 'membership_set_search_keys', 'user_sync_search_keys')`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
      'guard_last_admin',
      'guard_tenant_slug',
      'membership_set_search_keys',
      'user_sync_search_keys',
    ]);
    for (const r of rows) {
      expect(r.config, r.proname).toContain('search_path=lms, pg_temp');
      expect(r.public_exec, r.proname).toBe(false);
    }
    for (const name of ['membership_set_search_keys', 'user_sync_search_keys']) {
      expect(rows.find((r) => r.proname === name)?.prosecdef, name).toBe(true);
    }
  });
});

describe('every function checks that the ACTOR is a platform admin', () => {
  // lms_app may EXECUTE them, so the function itself must refuse anyone else (42501).
  const notAdmin = () => A.adminUserId; // an institution admin is not a platform admin
  const calls: [string, string, unknown[]][] = [
    ['platform_list_tenants', 'SELECT * FROM lms.platform_list_tenants($1, NULL, NULL, 10)', [0]],
    ['platform_get_tenant', 'SELECT * FROM lms.platform_get_tenant($1, $2)', [0, 'tenant']],
    [
      'platform_update_tenant',
      "SELECT * FROM lms.platform_update_tenant($1, $2, 'x', gen_random_uuid(), NULL)",
      [0, 'tenant'],
    ],
    [
      'platform_set_tenant_status',
      "SELECT * FROM lms.platform_set_tenant_status($1, $2, 'suspended', gen_random_uuid(), NULL)",
      [0, 'tenant'],
    ],
    [
      'platform_list_audit',
      'SELECT * FROM lms.platform_list_audit($1, NULL, NULL, NULL, NULL, NULL, 10)',
      [0],
    ],
    [
      'platform_list_audit_v2',
      'SELECT * FROM lms.platform_list_audit_v2($1, NULL, NULL, NULL, NULL, NULL, 10)',
      [0],
    ],
    [
      'platform_admin_invite',
      `SELECT * FROM lms.platform_admin_invite($1, $2, gen_random_uuid(), 'x@y.test', 'X',
         gen_random_uuid(), gen_random_uuid(), decode(repeat('01', 32), 'hex'), 60, gen_random_uuid(), NULL)`,
      [0, 'tenant'],
    ],
    [
      'platform_create_tenant',
      `SELECT * FROM lms.platform_create_tenant($1, gen_random_uuid(), 'pf-evil', 'Evil', gen_random_uuid(),
         'x@y.test', 'X', gen_random_uuid(), gen_random_uuid(), decode(repeat('02', 32), 'hex'), 60,
         gen_random_uuid(), gen_random_uuid(), NULL)`,
      [0],
    ],
  ];

  it.each(calls)(
    '%s refuses a non-platform-admin actor and a random id',
    async (_name, text, params) => {
      const bind = (actor: string) =>
        params.map((p) => (p === 0 ? actor : p === 'tenant' ? A.tenantId : p));
      await expectPgError(app.query(text, bind(notAdmin())), SQLSTATE.insufficientPrivilege);
      await expectPgError(app.query(text, bind(newId())), SQLSTATE.insufficientPrivilege);
      const evil = await owner.query("SELECT 1 FROM lms.tenants WHERE slug = 'pf-evil'");
      expect(evil.rowCount).toBe(0);
    },
  );

  it('a real platform admin gets rows; the column lists are the documented ones', async () => {
    const cols = async (text: string, params: unknown[]) =>
      (await app.query(text, params)).fields.map((f) => f.name);
    expect(
      await cols('SELECT * FROM lms.platform_list_tenants($1, NULL, NULL, 5)', [root.userId]),
    ).toEqual(['r_id', 'r_slug', 'r_name', 'r_status', 'r_created_at', 'r_updated_at']);
    expect(
      await cols('SELECT * FROM lms.platform_get_tenant($1, $2)', [root.userId, A.tenantId]),
    ).toEqual([
      'r_id',
      'r_slug',
      'r_name',
      'r_status',
      'r_created_at',
      'r_updated_at',
      'r_members',
      'r_active_admins',
    ]);
    expect(
      await cols('SELECT * FROM lms.platform_list_audit($1, NULL, NULL, NULL, NULL, NULL, 5)', [
        root.userId,
      ]),
    ).toEqual([
      'r_id',
      'r_actor_user_id',
      'r_action',
      'r_target_type',
      'r_target_id',
      'r_metadata',
      'r_created_at',
      'r_cursor_at',
    ]);
    const got = await app.query('SELECT * FROM lms.platform_get_tenant($1, $2)', [
      root.userId,
      A.tenantId,
    ]);
    expect(got.rows[0]).toEqual(
      expect.objectContaining({ r_slug: 'pf-a', r_members: 2, r_active_admins: 1 }),
    );
  });

  it('cannot be hijacked through search_path or a temp users table naming a fake platform admin', async () => {
    const client = await app.connect();
    try {
      await client.query('CREATE TEMP TABLE users (id uuid, is_platform_admin boolean)');
      const fake = newId();
      await client.query('INSERT INTO users VALUES ($1, true)', [fake]);
      await client.query('SET search_path = pg_temp, public');
      await expectPgError(
        client.query('SELECT * FROM lms.platform_list_tenants($1, NULL, NULL, 5)', [fake]),
        SQLSTATE.insufficientPrivilege,
      );
      const real = await client.query(
        'SELECT * FROM lms.platform_list_tenants($1, NULL, NULL, 5)',
        [root.userId],
      );
      expect(real.rowCount).toBeGreaterThan(0);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release(true);
    }
  });
});

describe('what lms_app can and cannot do to tenants directly', () => {
  it('cannot read other tenants, update a tenant, or touch the platform audit log', async () => {
    const client = await app.connect();
    try {
      // no tenant context: every tenant row is invisible
      expect((await client.query('SELECT * FROM lms.tenants')).rowCount).toBe(0);
    } finally {
      client.release();
    }
    await expectPgError(
      app.query("UPDATE lms.tenants SET name = 'x'"),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      app.query('SELECT * FROM lms.platform_audit_log'),
      SQLSTATE.insufficientPrivilege,
    );
  });
});

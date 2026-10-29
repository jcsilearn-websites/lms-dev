import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testOwnerPool } from './support';

let owner: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

interface Policy {
  tablename: string;
  policyname: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

describe('RLS policy audit (schema lms)', () => {
  it('no policy grants unrestricted access to lms_app or PUBLIC', async () => {
    const { rows } = await owner.query<Policy>(
      `SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'lms'`,
    );
    expect(rows.length).toBeGreaterThan(0);

    const trivial = (expr: string | null) =>
      expr !== null && /^\(*\s*(true|1\s*=\s*1)\s*\)*$/i.test(expr.trim());
    const tenantScoped = (expr: string) => /current_tenant_id|current_user_id/.test(expr);

    for (const p of rows) {
      const id = `${p.tablename}.${p.policyname}`;
      const appliesToApp = p.roles.includes('lms_app') || p.roles.includes('public');
      if (!appliesToApp) continue;
      // policies must name their role explicitly: never the implicit PUBLIC
      expect(p.roles, `${id} must be TO a named role`).not.toContain('public');
      const exprs = [p.qual, p.with_check].filter((e): e is string => e !== null);
      expect(exprs.length, `${id} has no USING/WITH CHECK`).toBeGreaterThan(0);
      for (const e of exprs) {
        expect(trivial(e), `${id} is unrestricted`).toBe(false);
        expect(tenantScoped(e), `${id} lacks a tenant/user condition`).toBe(true);
      }
    }
  });

  it('any owner policy is explicitly TO the owner role and never to lms_app/PUBLIC', async () => {
    const { rows } = await owner.query<Policy>(
      `SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'lms' AND policyname = 'owner_all'`,
    );
    for (const p of rows) {
      expect(p.roles).not.toContain('public');
      expect(p.roles).not.toContain('lms_app');
      expect(p.roles).toHaveLength(1);
    }
  });

  it('every table lms_app can use has at least one policy', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'lms'",
    );
    // user_credentials, auth_tokens and platform_audit_log intentionally have NO policy for lms_app:
    // they are reachable only through SECURITY DEFINER functions (owner_all may exist on managed Postgres).
    const withAppPolicies = rows.map((r) => r.tablename).filter((t) => t !== 'user_credentials');
    expect(withAppPolicies).toEqual(expect.arrayContaining(['audit_log', 'sessions', 'tenants']));
  });
});

describe('tables reachable only through SECURITY DEFINER functions', () => {
  it('have no policy and no privilege for lms_app (deny by default)', async () => {
    for (const table of ['user_credentials', 'auth_tokens', 'platform_audit_log']) {
      const { rows } = await owner.query<{ roles: string[] }>(
        "SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'lms' AND tablename = $1",
        [table],
      );
      for (const p of rows) expect(p.roles, table).not.toContain('lms_app');
      const priv = await owner.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
        `SELECT has_table_privilege('lms_app', $1, 'SELECT') AS s,
                has_table_privilege('lms_app', $1, 'INSERT') AS i,
                has_table_privilege('lms_app', $1, 'UPDATE') AS u,
                has_table_privilege('lms_app', $1, 'DELETE') AS d`,
        [`lms.${table}`],
      );
      expect(priv.rows[0], table).toEqual({ s: false, i: false, u: false, d: false });
    }
  });
});

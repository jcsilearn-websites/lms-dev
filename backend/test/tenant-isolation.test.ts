import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { createDb, type Database } from '../src/db/client';
import { auditLog } from '../src/modules/audit/audit.model';
import { tenantMemberships } from '../src/modules/memberships/memberships.model';
import { tenantSettings, tenants } from '../src/modules/tenants/tenants.model';
import { users } from '../src/modules/users/users.model';
import { expectPgError, SQLSTATE } from './helpers';
import {
  createTenantFixture,
  type TenantFixture,
  testAppDbOptions,
  testAppPool,
  testOwnerPool,
} from './support';

let owner: pg.Pool;
let rawApp: pg.Pool;
let db: Database;
let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  owner = testOwnerPool();
  rawApp = testAppPool();
  db = createDb(testAppDbOptions(2));
  A = await createTenantFixture(owner, 'tenant-a');
  B = await createTenantFixture(owner, 'tenant-b');
});

afterAll(async () => {
  await db.close();
  await rawApp.end();
  await owner.end();
});

const settingRow = (tenantId: string, key: string, extra: object = {}) => ({
  id: newId(),
  tenantId,
  key,
  value: { v: key },
  ...extra,
});

describe('tenant isolation (RLS)', () => {
  it('data written under tenant A is invisible under tenant B', async () => {
    await db.withTenant(A.tenantId, (tx) =>
      tx.insert(tenantSettings).values(settingRow(A.tenantId, 'a-only')),
    );
    const underA = await db.withTenant(A.tenantId, (tx) => tx.select().from(tenantSettings));
    const underB = await db.withTenant(B.tenantId, (tx) => tx.select().from(tenantSettings));
    expect(underA.map((r) => r.key)).toEqual(['a-only']);
    expect(underB).toEqual([]);
  });

  it('with no tenant set, every table returns zero rows', async () => {
    for (const table of [
      'tenants',
      'users',
      'tenant_memberships',
      'audit_log',
      'tenant_settings',
      'jobs',
      'member_profiles',
      'import_jobs',
      'import_rows',
      'academic_years',
      'terms',
      'departments',
      'programs',
      'batches',
      'sections',
      'courses',
      'course_offerings',
      'offering_sections',
      'course_participants',
      'course_sync_pending',
      'files',
      'content_modules',
      'content_items',
    ]) {
      const { rows } = await rawApp.query(`SELECT 1 FROM lms.${table}`);
      expect(rows, table).toHaveLength(0);
    }
    // sanity: the owner can see the fixture data, so "zero rows" is RLS and not an empty DB
    const { rows } = await owner.query('SELECT 1 FROM lms.tenants');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('tenants: a tenant sees only itself', async () => {
    const rows = await db.withTenant(A.tenantId, (tx) => tx.select().from(tenants));
    expect(rows.map((r) => r.id)).toEqual([A.tenantId]);
  });

  it('cannot insert a row for another tenant', async () => {
    await expectPgError(
      db.withTenant(B.tenantId, (tx) =>
        tx.insert(tenantSettings).values(settingRow(A.tenantId, 'sneaky')),
      ),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      db.withTenant(B.tenantId, (tx) =>
        tx.insert(tenantMemberships).values({
          id: newId(),
          tenantId: A.tenantId,
          userId: B.memberUserId,
          role: 'member',
        }),
      ),
      SQLSTATE.insufficientPrivilege,
    );
  });

  it('cannot update or delete another tenant rows (they are invisible)', async () => {
    const upd = await db.withTenant(B.tenantId, (tx) =>
      tx
        .update(tenantSettings)
        .set({ value: { hacked: true } })
        .where(eq(tenantSettings.key, 'a-only'))
        .returning(),
    );
    const del = await db.withTenant(B.tenantId, (tx) =>
      tx.delete(tenantSettings).where(eq(tenantSettings.key, 'a-only')).returning(),
    );
    expect(upd).toEqual([]);
    expect(del).toEqual([]);
    const still = await db.withTenant(A.tenantId, (tx) => tx.select().from(tenantSettings));
    expect(still).toHaveLength(1);
  });

  it('composite FK: a row cannot reference another tenant row', async () => {
    // updated_by_membership_id points at tenant B's membership, but the row belongs to A.
    await expectPgError(
      db.withTenant(A.tenantId, (tx) =>
        tx
          .insert(tenantSettings)
          .values(
            settingRow(A.tenantId, 'cross-ref', { updatedByMembershipId: B.adminMembershipId }),
          ),
      ),
      SQLSTATE.foreignKeyViolation,
    );
    // ...while referencing its own tenant's membership works.
    await db.withTenant(A.tenantId, (tx) =>
      tx
        .insert(tenantSettings)
        .values(settingRow(A.tenantId, 'own-ref', { updatedByMembershipId: A.adminMembershipId })),
    );
    // The owner role is not exempt from the composite FK either.
    await expectPgError(
      owner.query(
        `INSERT INTO lms.tenant_settings (id, tenant_id, key, value, updated_by_membership_id)
         VALUES ($1, $2, 'owner-cross', '{}', $3)`,
        [newId(), A.tenantId, B.adminMembershipId],
      ),
      SQLSTATE.foreignKeyViolation,
    );
  });

  it('users in tenant B are invisible from tenant A', async () => {
    const visible = await db.withTenant(A.tenantId, (tx) => tx.select().from(users));
    expect(visible.map((u) => u.id).sort()).toEqual([A.adminUserId, A.memberUserId].sort());
    const probe = await db.withTenant(A.tenantId, (tx) =>
      tx.select().from(users).where(eq(users.id, B.adminUserId)),
    );
    expect(probe).toEqual([]);
  });

  it('memberships are visible only for the current tenant', async () => {
    const underA = await db.withTenant(A.tenantId, (tx) => tx.select().from(tenantMemberships));
    expect(underA.every((m) => m.tenantId === A.tenantId)).toBe(true);
    expect(underA).toHaveLength(2);
    const probe = await db.withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.id, B.adminMembershipId))),
    );
    expect(probe).toEqual([]);
  });

  it('app.user_id lets the current user see their own users row, nothing else extra', async () => {
    const rows = await db.withTenant(A.tenantId, (tx) => tx.select().from(users), {
      userId: B.memberUserId,
    });
    expect(rows.map((u) => u.id).sort()).toEqual(
      [A.adminUserId, A.memberUserId, B.memberUserId].sort(),
    );
  });

  it('withTenant rolls back on error and does not leak tenant context between calls', async () => {
    await expect(
      db.withTenant(A.tenantId, async (tx) => {
        await tx.insert(tenantSettings).values(settingRow(A.tenantId, 'rolled-back'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.withTenant(A.tenantId, (tx) =>
      tx.select().from(tenantSettings).where(eq(tenantSettings.key, 'rolled-back')),
    );
    expect(rows).toEqual([]);

    // Single-connection pool: the next call reuses the same connection and must see only its own tenant.
    const single = createDb(testAppDbOptions(1));
    try {
      await single.withTenant(A.tenantId, (tx) => tx.select().from(tenants));
      const rowsB = await single.withTenant(B.tenantId, (tx) => tx.select().from(tenants));
      expect(rowsB.map((t) => t.id)).toEqual([B.tenantId]);
    } finally {
      await single.close();
    }
  });

  it('withTenant rejects non-UUID tenant ids', async () => {
    await expect(db.withTenant('not-a-uuid', async () => 1)).rejects.toThrow(TypeError);
    await expect(db.withTenant("'; drop table lms.tenants; --", async () => 1)).rejects.toThrow(
      TypeError,
    );
  });
});

describe('lms_app privileges', () => {
  it('cannot bypass or disable RLS', async () => {
    const { rows } = await rawApp.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    await expectPgError(
      rawApp.query('ALTER TABLE lms.tenant_settings DISABLE ROW LEVEL SECURITY'),
      '42501',
    );
    await expectPgError(
      rawApp.query('ALTER TABLE lms.tenant_settings NO FORCE ROW LEVEL SECURITY'),
      '42501',
    );
    await expectPgError(
      rawApp.query('DROP POLICY tenant_settings_all ON lms.tenant_settings'),
      '42501',
    );
    await expectPgError(rawApp.query('SET ROLE postgres'), '42501');

    // row_security = off makes Postgres raise instead of returning rows the policy would hide.
    const client = await rawApp.connect();
    try {
      await client.query('SET row_security = off');
      await expectPgError(client.query('SELECT * FROM lms.tenant_settings'), '42501');
    } finally {
      client.release();
    }
  });

  it('RLS is enabled and forced on every tenant-owned table', async () => {
    const { rows } = await rawApp.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS on, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'lms' AND c.relkind = 'r' AND c.relname NOT IN ('schema_migrations', 'role_password_state')`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [
        'audit_log',
        'academic_years',
        'auth_tokens',
        'batches',
        'content_items',
        'content_modules',
        'course_offerings',
        'course_participants',
        'course_sync_pending',
        'courses',
        'departments',
        'files',
        'import_jobs',
        'import_rows',
        'jobs',
        'member_profiles',
        'offering_sections',
        'platform_audit_log',
        'programs',
        'sections',
        'sessions',
        'tenant_memberships',
        'tenant_settings',
        'tenants',
        'terms',
        'user_credentials',
        'users',
      ].sort(),
    );
    for (const r of rows) expect({ ...r }, r.relname).toMatchObject({ on: true, forced: true });
  });

  it('owns nothing and cannot create objects in lms or touch schema_migrations', async () => {
    const { rows } = await rawApp.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       WHERE r.rolname = current_user AND c.relnamespace = 'lms'::regnamespace`,
    );
    expect(rows[0]?.n).toBe('0');
    await expectPgError(rawApp.query('CREATE TABLE lms.evil (id int)'), '42501');
    await expectPgError(rawApp.query('SELECT * FROM lms.schema_migrations'), '42501');
  });

  it('cannot change users (e.g. grant itself platform admin) or rewrite tenants', async () => {
    await expectPgError(
      db.withTenant(A.tenantId, (tx) =>
        tx.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, A.memberUserId)),
      ),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      db.withTenant(A.tenantId, (tx) => tx.update(tenants).set({ name: 'x' })),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      db.withTenant(A.tenantId, (tx) =>
        tx.update(tenantMemberships).set({ userId: B.adminUserId }),
      ),
      SQLSTATE.insufficientPrivilege,
    );
  });

  it('audit_log is append-only: INSERT and SELECT only', async () => {
    const entry = {
      id: newId(),
      tenantId: A.tenantId,
      actorUserId: A.adminUserId,
      action: 'test.action',
      targetType: 'test',
    };
    await db.withTenant(A.tenantId, (tx) => tx.insert(auditLog).values(entry));
    const rows = await db.withTenant(A.tenantId, (tx) => tx.select().from(auditLog));
    expect(rows.map((r) => r.id)).toContain(entry.id);
    expect(await db.withTenant(B.tenantId, (tx) => tx.select().from(auditLog))).toEqual([]);

    await expectPgError(
      db.withTenant(A.tenantId, (tx) => tx.update(auditLog).set({ action: 'tampered' })),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(
      db.withTenant(A.tenantId, (tx) => tx.delete(auditLog)),
      SQLSTATE.insufficientPrivilege,
    );
    await expectPgError(rawApp.query('TRUNCATE lms.audit_log'), SQLSTATE.insufficientPrivilege);
    // and cannot write audit rows for another tenant
    await expectPgError(
      db.withTenant(B.tenantId, (tx) =>
        tx.insert(auditLog).values({ ...entry, id: newId(), tenantId: A.tenantId }),
      ),
      SQLSTATE.insufficientPrivilege,
    );
  });

  it('schema lms is closed to PUBLIC, anon and authenticated', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `SELECT DISTINCT (aclexplode(nspacl)).grantee::regrole::text AS grantee
       FROM pg_namespace WHERE nspname = 'lms'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain('-'); // PUBLIC
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('authenticated');
    expect(grantees).toContain('lms_app');
  });
});

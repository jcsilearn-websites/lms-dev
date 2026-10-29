import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/core/uuid';
import { expectPgError, SQLSTATE } from './helpers';
import { createTenantFixture, testOwnerPool } from './support';

let owner: pg.Pool;

beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

describe('role model', () => {
  it('membership role enum has exactly institution_admin and member', async () => {
    const { rows } = await owner.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'membership_role' AND t.typnamespace = 'lms'::regnamespace
       ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['institution_admin', 'member']);
  });

  it('accepts the two valid roles and rejects anything else', async () => {
    const f = await createTenantFixture(owner, 'role-tenant');
    // each membership needs its own real user for the FK
    const mkUser = async (email: string) => {
      const id = newId();
      await owner.query('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3)', [
        id,
        email,
        'x',
      ]);
      return id;
    };
    const add = async (email: string, role: string) =>
      owner.query(
        'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [newId(), f.tenantId, await mkUser(email), role],
      );
    await add('r1@role.test', 'institution_admin');
    await add('r2@role.test', 'member');
    for (const bad of [
      'student',
      'faculty',
      'teaching_assistant',
      'platform_admin',
      'MEMBER',
      '',
    ]) {
      await expectPgError(
        add(`bad-${bad.toLowerCase() || 'empty'}@role.test`, bad),
        SQLSTATE.invalidEnum,
      );
    }
  });

  it('membership role defaults to member', async () => {
    const f = await createTenantFixture(owner, 'default-role');
    const userId = newId();
    await owner.query('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3)', [
      userId,
      'dflt@role.test',
      'x',
    ]);
    const { rows } = await owner.query<{ role: string }>(
      'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id) VALUES ($1, $2, $3) RETURNING role',
      [newId(), f.tenantId, userId],
    );
    expect(rows[0]?.role).toBe('member');
  });

  it('users.is_platform_admin defaults to false and is NOT NULL', async () => {
    const { rows } = await owner.query<{ is_platform_admin: boolean }>(
      "INSERT INTO lms.users (id, email, display_name) VALUES ($1, 'plain@role.test', 'x') RETURNING is_platform_admin",
      [newId()],
    );
    expect(rows[0]?.is_platform_admin).toBe(false);
    await expectPgError(
      owner.query(
        "INSERT INTO lms.users (id, email, display_name, is_platform_admin) VALUES ($1, 'null@role.test', 'x', NULL)",
        [newId()],
      ),
      '23502',
    );
  });

  it('platform admins are not tenant members by default', async () => {
    const id = newId();
    await owner.query(
      "INSERT INTO lms.users (id, email, display_name, is_platform_admin) VALUES ($1, 'pa@role.test', 'PA', true)",
      [id],
    );
    const { rows } = await owner.query('SELECT 1 FROM lms.tenant_memberships WHERE user_id = $1', [
      id,
    ]);
    expect(rows).toHaveLength(0);
  });
});

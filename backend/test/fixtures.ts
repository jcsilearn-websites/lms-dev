import type pg from 'pg';
import { newId } from '../src/core/uuid';
import { setPassword, TEST_PASSWORD } from './support';

/** An extra member with TEST_PASSWORD (a fresh user, so a test can lock or mutate it freely). */
export async function addMember(
  owner: pg.Pool,
  tenantId: string,
  email: string,
  opts: {
    role?: 'member' | 'institution_admin';
    status?: 'active' | 'pending' | 'suspended';
    password?: string;
    displayName?: string;
  } = {},
): Promise<{ userId: string; membershipId: string; email: string }> {
  const userId = newId();
  const membershipId = newId();
  await owner.query('INSERT INTO lms.users (id, email, display_name) VALUES ($1, $2, $3)', [
    userId,
    email,
    opts.displayName ?? 'Extra',
  ]);
  await owner.query(
    'INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4, $5)',
    [membershipId, tenantId, userId, opts.role ?? 'member', opts.status ?? 'active'],
  );
  await setPassword(owner, userId, opts.password ?? TEST_PASSWORD);
  return { userId, membershipId, email };
}

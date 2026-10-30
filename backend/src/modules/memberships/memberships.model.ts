import { text, uuid } from 'drizzle-orm/pg-core';
import { MEMBERSHIP_ROLES } from '../../contracts';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

export const membershipRole = lms.enum('membership_role', MEMBERSHIP_ROLES);

export const membershipStatus = lms.enum('membership_status', [
  'active',
  'pending',
  'suspended',
  'removed',
]);

export const tenantMemberships = lms.table('tenant_memberships', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: membershipRole('role').notNull().default('member'),
  status: membershipStatus('status').notNull().default('active'),
  // lowercased copies of the user's name / email, maintained by triggers (tenant-scoped prefix search)
  searchName: text('search_name'),
  searchEmail: text('search_email'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

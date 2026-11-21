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

// "This member is shown under this name in this college" (data protection, step 14b). Written only by the erasure functions;
// every college-scoped reader of a name or an address reads it through the view lms.member_identity (migration 0060).
export const membershipDisplayOverrides = lms.table('membership_display_overrides', {
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  pseudonym: text('pseudonym').notNull(),
  createdAt: createdAt(),
});

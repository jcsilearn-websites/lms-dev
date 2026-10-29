import { jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

export const tenantStatus = lms.enum('tenant_status', ['active', 'suspended']);

export const tenants = lms.table('tenants', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// tenant_settings belongs to the tenants module (the example tenant-owned table for RLS).
export const tenantSettings = lms.table('tenant_settings', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedByMembershipId: uuid('updated_by_membership_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

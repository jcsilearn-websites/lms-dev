import { jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inet, lms } from '../../db/lms-schema';

// Append-only for the application role (lms_app has INSERT + SELECT only).
export const auditLog = lms.table('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: createdAt(),
});

// Events with no tenant (platform-admin host logins, lockouts, ...). lms_app has no privileges on
// it: rows are written through the SECURITY DEFINER function lms.auth_audit_platform.
export const platformAuditLog = lms.table('platform_audit_log', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  metadata: jsonb('metadata').notNull().default({}),
  ip: inet('ip'),
  createdAt: createdAt(),
});

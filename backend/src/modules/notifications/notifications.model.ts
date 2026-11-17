import { boolean, date, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { lms } from '../../db/lms-schema';

// Tables owned by the notifications module (migration 0052). lms_app reads its OWN notifications and preferences under RLS
// (tenant AND app.user_id) and may only set read_at; rows are created by the fan-out (definer). The platform inbox and the
// scheduling state are reachable only through definer functions. Keys and indexes live in the migration.
export const notifications = lms.table('notifications', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  category: text('category').notNull(),
  type: text('type').notNull(),
  params: jsonb('params').notNull(),
  link: text('link'),
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});

export const notificationPreferences = lms.table('notification_preferences', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  category: text('category').notNull(),
  email: boolean('email').notNull(),
  inApp: boolean('in_app').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const platformNotifications = lms.table('platform_notifications', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  params: jsonb('params').notNull(),
  link: text('link'),
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});

export const notifyContentMarks = lms.table('notify_content_marks', {
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  visibleAt: timestamp('visible_at', { withTimezone: true }).notNull(),
});

export const notifyScanState = lms.table('notify_scan_state', {
  tenantId: uuid('tenant_id').primaryKey(),
  scannedUntil: timestamp('scanned_until', { withTimezone: true }).notNull(),
});

export const notifyRuns = lms.table('notify_runs', {
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  localDate: date('local_date').notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
});

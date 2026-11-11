import { integer, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms } from '../../db/lms-schema';

// Migration 0033. Versions are immutable (lms_app can only INSERT them): a grade points at the exact version it used.
export const rubrics = lms.table('rubrics', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  courseId: uuid('course_id').notNull(),
  title: text('title').notNull(),
  currentVersionId: uuid('current_version_id'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rubricVersions = lms.table('rubric_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  rubricId: uuid('rubric_id').notNull(),
  versionNo: integer('version_no').notNull(),
  criteria: jsonb('criteria').notNull(),
  maxPoints: numeric('max_points', { precision: 8, scale: 2 }).notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

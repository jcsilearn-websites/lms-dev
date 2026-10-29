import { boolean, date, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

// Mirrors migration 0011. Nothing that history depends on is hard-deleted: rows are archived
// (archived_at) and every reference is ON DELETE RESTRICT.
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const academicYears = lms.table('academic_years', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  label: text('label').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const terms = lms.table('terms', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  name: text('name').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const departments = lms.table('departments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const programs = lms.table('programs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  departmentId: uuid('department_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  durationYears: smallint('duration_years').notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const batches = lms.table('batches', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  programId: uuid('program_id').notNull(),
  admissionYear: smallint('admission_year').notNull(),
  graduationYear: smallint('graduation_year').notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sections = lms.table('sections', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  code: text('code').notNull(),
  archivedAt: archivedAt(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

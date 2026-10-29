import { boolean, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

export const importKind = lms.enum('import_kind', ['students', 'faculty']);
export const importStatus = lms.enum('import_status', [
  'parsing',
  'validated',
  'failed',
  'queued',
  'processing',
  'completed',
  'completed_with_errors',
  'cancelled',
]);
export const importRowStatus = lms.enum('import_row_status', [
  'pending',
  'valid',
  'invalid',
  'processed',
  'skipped',
  'failed',
]);

// One row per upload (migration 0013). At most one import per tenant is queued/processing (partial
// unique index). The counts are recomputed from import_rows after every batch.
export const importJobs = lms.table('import_jobs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: importKind('kind').notNull(),
  fileName: text('file_name').notNull(),
  status: importStatus('status').notNull().default('parsing'),
  updateExisting: boolean('update_existing').notNull().default(false),
  skipInvalid: boolean('skip_invalid').notNull().default(false),
  totalRows: integer('total_rows').notNull().default(0),
  validRows: integer('valid_rows').notNull().default(0),
  invalidRows: integer('invalid_rows').notNull().default(0),
  processedRows: integer('processed_rows').notNull().default(0),
  skippedRows: integer('skipped_rows').notNull().default(0),
  failedRows: integer('failed_rows').notNull().default(0),
  createdMembers: integer('created_members').notNull().default(0),
  updatedMembers: integer('updated_members').notNull().default(0),
  error: text('error'),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  rowsPurgedAt: timestamp('rows_purged_at', { withTimezone: true }),
});

// The staging table: the parsed file, validated by set-based SQL before anything touches real tables.
// Deleted after IMPORT_RETENTION_DAYS (it holds names and emails).
export const importRows = lms.table('import_rows', {
  tenantId: uuid('tenant_id').notNull(),
  importId: uuid('import_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  status: importRowStatus('status').notNull().default('pending'),
  raw: jsonb('raw').notNull(),
  email: text('email'),
  fullName: text('full_name'),
  registerNumber: text('register_number'),
  employeeId: text('employee_id'),
  departmentCode: text('department_code'),
  programCode: text('program_code'),
  batchLabel: text('batch_label'),
  sectionCode: text('section_code'),
  phone: text('phone'),
  departmentId: uuid('department_id'),
  programId: uuid('program_id'),
  batchId: uuid('batch_id'),
  sectionId: uuid('section_id'),
  errors: jsonb('errors').notNull().default([]),
  result: text('result'),
});

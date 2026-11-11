import { integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms } from '../../db/lms-schema';

// Migration 0028. Versions are immutable (lms_app can only INSERT them); nothing here is ever deleted except tags and the
// staging rows of a CSV import.
export const questions = lms.table('questions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  courseId: uuid('course_id').notNull(),
  currentVersionId: uuid('current_version_id').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const questionVersions = lms.table('question_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id').notNull(),
  version: integer('version').notNull(),
  type: text('type').notNull(),
  difficulty: text('difficulty').notNull().default('medium'),
  presentation: jsonb('presentation').notNull(),
  answerKey: jsonb('answer_key').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const questionTags = lms.table(
  'question_tags',
  {
    tenantId: uuid('tenant_id').notNull(),
    courseId: uuid('course_id').notNull(),
    questionId: uuid('question_id').notNull(),
    tag: text('tag').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.questionId, t.tag] })],
);

export const questionFiles = lms.table(
  'question_files',
  {
    tenantId: uuid('tenant_id').notNull(),
    questionVersionId: uuid('question_version_id').notNull(),
    fileId: uuid('file_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.questionVersionId, t.fileId] })],
);

export const questionImports = lms.table('question_imports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  courseId: uuid('course_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  fileName: text('file_name').notNull(),
  status: text('status').notNull().default('staged'),
  totalRows: integer('total_rows').notNull(),
  validRows: integer('valid_rows').notNull(),
  createdCount: integer('created_count').notNull().default(0),
  createdAt: createdAt(),
});

export const questionImportRows = lms.table(
  'question_import_rows',
  {
    tenantId: uuid('tenant_id').notNull(),
    importId: uuid('import_id').notNull(),
    rowNo: integer('row_no').notNull(),
    raw: jsonb('raw').notNull(),
    parsed: jsonb('parsed'),
    errors: jsonb('errors').notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.importId, t.rowNo] })],
);

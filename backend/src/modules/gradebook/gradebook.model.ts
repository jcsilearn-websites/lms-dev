import {
  boolean,
  integer,
  jsonb,
  numeric,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, lms } from '../../db/lms-schema';

// Migration 0039. Everything that has been APPROVED is history: gradebook_versions and gradebook_snapshot_rows are
// INSERT-only (a trigger refuses UPDATE and DELETE for everybody), events and mark history are append-only, overrides are
// revoked and never deleted. Foreign keys into history are ON DELETE RESTRICT.

export const gradeScales = lms.table('grade_scales', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gradeScaleBands = lms.table(
  'grade_scale_bands',
  {
    tenantId: uuid('tenant_id').notNull(),
    scaleId: uuid('scale_id').notNull(),
    minPercent: numeric('min_percent', { precision: 6, scale: 3 }).notNull(),
    label: text('label').notNull(),
    gradePoints: numeric('grade_points', { precision: 4, scale: 2 }),
    isPass: boolean('is_pass').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scaleId, t.minPercent] })],
);

export const gradebooks = lms.table('gradebooks', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  status: text('status').notNull().default('draft'),
  weighted: boolean('weighted').notNull().default(false),
  outOf: numeric('out_of', { precision: 8, scale: 2 }).notNull().default('100'),
  roundMode: text('round_mode').notNull().default('half_up'),
  roundDecimals: smallint('round_decimals').notNull().default(0),
  scaleId: uuid('scale_id'),
  versionNo: integer('version_no').notNull().default(1),
  exportLayout: jsonb('export_layout'),
  submittedBy: uuid('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewComment: text('review_comment'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gradebookCategories = lms.table('gradebook_categories', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  name: text('name').notNull(),
  weight: numeric('weight', { precision: 6, scale: 3 }).notNull().default('0'),
  dropLowest: smallint('drop_lowest').notNull().default(0),
  missingPolicy: text('missing_policy').notNull().default('exclude'),
  position: integer('position').notNull().default(0),
});

export const gradebookItems = lms.table('gradebook_items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  source: text('source').notNull(),
  contentItemId: uuid('content_item_id'),
  title: text('title'),
  points: numeric('points', { precision: 8, scale: 2 }).notNull(),
  extraCredit: boolean('extra_credit').notNull().default(false),
  position: integer('position').notNull().default(0),
  dueAt: timestamp('due_at', { withTimezone: true }),
  released: boolean('released').notNull().default(false),
  assistantsMayEnter: boolean('assistants_may_enter').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const manualMarks = lms.table(
  'manual_marks',
  {
    tenantId: uuid('tenant_id').notNull(),
    itemId: uuid('item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    points: numeric('points', { precision: 8, scale: 2 }).notNull(),
    rev: integer('rev').notNull().default(1),
    enteredBy: uuid('entered_by').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.itemId, t.participantId] })],
);

export const manualMarkHistory = lms.table('manual_mark_history', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  beforePoints: numeric('before_points', { precision: 8, scale: 2 }),
  afterPoints: numeric('after_points', { precision: 8, scale: 2 }),
  source: text('source').notNull(),
  changedBy: uuid('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gradeOverrides = lms.table('grade_overrides', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  itemId: uuid('item_id'),
  points: numeric('points', { precision: 8, scale: 2 }).notNull(),
  reason: text('reason').notNull(),
  setBy: uuid('set_by').notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
});

export const gradebookEvents = lms.table('gradebook_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  versionNo: integer('version_no').notNull(),
  action: text('action').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  selfApproved: boolean('self_approved').notNull().default(false),
  comment: text('comment'),
  createdAt: createdAt(),
});

export const gradebookVersions = lms.table('gradebook_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  versionNo: integer('version_no').notNull(),
  config: jsonb('config').notNull(),
  excluded: jsonb('excluded').notNull().default([]),
  learnerCount: integer('learner_count').notNull(),
  submittedBy: uuid('submitted_by'),
  approvedBy: uuid('approved_by').notNull(),
  selfApproved: boolean('self_approved').notNull().default(false),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gradebookSnapshotRows = lms.table(
  'gradebook_snapshot_rows',
  {
    tenantId: uuid('tenant_id').notNull(),
    versionId: uuid('version_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    registerNumber: text('register_number'),
    displayName: text('display_name').notNull(),
    email: text('email'),
    sectionCode: text('section_code'),
    sortKey: text('sort_key').notNull(),
    cells: jsonb('cells').notNull(),
    cats: jsonb('cats').notNull(),
    finalMarks: numeric('final_marks', { precision: 10, scale: 4 }),
    finalPercent: numeric('final_percent', { precision: 10, scale: 4 }),
    grade: text('grade'),
    isPass: boolean('is_pass'),
    overridden: boolean('overridden').notNull().default(false),
    explanation: jsonb('explanation').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.versionId, t.participantId] })],
);

export const markImports = lms.table('mark_imports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  gradebookId: uuid('gradebook_id').notNull(),
  status: text('status').notNull().default('staged'),
  rowCount: integer('row_count').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const markImportCells = lms.table(
  'mark_import_cells',
  {
    tenantId: uuid('tenant_id').notNull(),
    importId: uuid('import_id').notNull(),
    rowNo: integer('row_no').notNull(),
    cellNo: smallint('cell_no').notNull(),
    registerNumber: text('register_number').notNull(),
    columnName: text('column_name').notNull(),
    itemId: uuid('item_id'),
    raw: text('raw').notNull(),
    participantId: uuid('participant_id'),
    points: numeric('points', { precision: 8, scale: 2 }),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.importId, t.rowNo, t.cellNo] })],
);

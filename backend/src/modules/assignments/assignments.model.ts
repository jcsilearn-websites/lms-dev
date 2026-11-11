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

// Migration 0033. Submissions and grades are HISTORY: every foreign key into them is ON DELETE RESTRICT and lms_app can
// neither update nor delete a submission. Learners write only through the definer functions assignment_upload_begin /
// assignment_submit; instructors grade through the grants on assignment_grades.

export const assignments = lms.table(
  'assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    itemId: uuid('item_id').notNull(),
    offeringId: uuid('offering_id').notNull(),
    courseId: uuid('course_id').notNull(),
    instructions: jsonb('instructions'),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    latePolicy: text('late_policy').notNull().default('none'),
    lateCutoffAt: timestamp('late_cutoff_at', { withTimezone: true }),
    penaltyKind: text('penalty_kind').notNull().default('per_day'),
    penaltyValue: numeric('penalty_value', { precision: 5, scale: 2 }).notNull().default('10'),
    penaltyCap: numeric('penalty_cap', { precision: 5, scale: 2 }).notNull().default('50'),
    maxPoints: numeric('max_points', { precision: 7, scale: 2 }).notNull().default('100'),
    passingScore: numeric('passing_score', { precision: 5, scale: 2 }),
    allowFile: boolean('allow_file').notNull().default(true),
    allowText: boolean('allow_text').notNull().default(false),
    allowLink: boolean('allow_link').notNull().default(false),
    maxFiles: smallint('max_files').notNull().default(3),
    maxFileMb: smallint('max_file_mb').notNull().default(25),
    resubmissionAllowed: boolean('resubmission_allowed').notNull().default(true),
    anonymousGrading: boolean('anonymous_grading').notNull().default(false),
    releaseMode: text('release_mode').notNull().default('manual'),
    rubricId: uuid('rubric_id'),
    rubricVersionId: uuid('rubric_version_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.itemId] })],
);

export const assignmentAttachments = lms.table(
  'assignment_attachments',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    fileId: uuid('file_id').notNull(),
    position: smallint('position').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assignmentItemId, t.fileId] })],
);

export const assignmentExtensions = lms.table(
  'assignment_extensions',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    extendedDueAt: timestamp('extended_due_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    setBy: uuid('set_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assignmentItemId, t.participantId] })],
);

export const assignmentLearners = lms.table(
  'assignment_learners',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    learnerKey: uuid('learner_key').notNull(),
    anonCode: text('anon_code').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assignmentItemId, t.participantId] })],
);

export const assignmentUploads = lms.table(
  'assignment_uploads',
  {
    tenantId: uuid('tenant_id').notNull(),
    fileId: uuid('file_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.fileId] })],
);

export const submissions = lms.table('submissions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  assignmentItemId: uuid('assignment_item_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  versionNo: smallint('version_no').notNull(),
  textBody: text('text_body'),
  linkUrl: text('link_url'),
  requestKey: uuid('request_key').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  lateSeconds: integer('late_seconds').notNull().default(0),
  onGrace: boolean('on_grace').notNull().default(false),
});

export const submissionFiles = lms.table(
  'submission_files',
  {
    tenantId: uuid('tenant_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    fileId: uuid('file_id').notNull(),
    position: smallint('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.submissionId, t.fileId] })],
);

export const assignmentGrades = lms.table(
  'assignment_grades',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    rubricVersionId: uuid('rubric_version_id'),
    rubricSelection: jsonb('rubric_selection'),
    rubricScore: numeric('rubric_score', { precision: 8, scale: 2 }),
    rawScore: numeric('raw_score', { precision: 8, scale: 2 }).notNull(),
    overrideReason: text('override_reason'),
    feedback: jsonb('feedback'),
    penaltyPercent: numeric('penalty_percent', { precision: 5, scale: 2 }),
    penaltyWaived: boolean('penalty_waived').notNull().default(false),
    waiveReason: text('waive_reason'),
    waivedBy: uuid('waived_by'),
    gradedBy: uuid('graded_by').notNull(),
    gradedAt: timestamp('graded_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assignmentItemId, t.participantId] })],
);

export const assignmentFeedbackFiles = lms.table(
  'assignment_feedback_files',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentItemId: uuid('assignment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    fileId: uuid('file_id').notNull(),
    position: smallint('position').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assignmentItemId, t.participantId, t.fileId] })],
);

import {
  bigint,
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
import { lms } from '../../db/lms-schema';

// Migration 0029. Attempts are HISTORY: every foreign key is ON DELETE RESTRICT and nothing is deleted by the app.
// Learners write only through the definer functions assessment_start / attempt_save / attempt_submit; instructors grade
// through column grants on attempts / attempt_questions.

export const assessments = lms.table(
  'assessments',
  {
    tenantId: uuid('tenant_id').notNull(),
    itemId: uuid('item_id').notNull(),
    offeringId: uuid('offering_id').notNull(),
    courseId: uuid('course_id').notNull(),
    kind: text('kind').notNull().default('practice'),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    timeLimitMinutes: integer('time_limit_minutes'),
    attemptsAllowed: integer('attempts_allowed').notNull().default(1),
    scoring: text('scoring').notNull().default('highest'),
    shuffleQuestions: boolean('shuffle_questions').notNull().default(false),
    shuffleOptions: boolean('shuffle_options').notNull().default(false),
    passingScore: numeric('passing_score', { precision: 5, scale: 2 }),
    resultsVisibility: text('results_visibility').notNull().default('immediate'),
    answersVisibility: text('answers_visibility').notNull().default('never'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.itemId] })],
);

export const assessmentSlots = lms.table(
  'assessment_slots',
  {
    tenantId: uuid('tenant_id').notNull(),
    assessmentItemId: uuid('assessment_item_id').notNull(),
    position: smallint('position').notNull(),
    kind: text('kind').notNull(),
    questionId: uuid('question_id'),
    tag: text('tag'),
    difficulty: text('difficulty'),
    count: smallint('count').notNull().default(1),
    points: numeric('points', { precision: 6, scale: 2 }).notNull().default('1'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assessmentItemId, t.position] })],
);

export const assessmentAccommodations = lms.table(
  'assessment_accommodations',
  {
    tenantId: uuid('tenant_id').notNull(),
    assessmentItemId: uuid('assessment_item_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    extraMinutes: integer('extra_minutes').notNull().default(0),
    extendedCloseAt: timestamp('extended_close_at', { withTimezone: true }),
    // SENSITIVE: never joined into a list or export, never written to the audit log
    reason: text('reason'),
    setBy: uuid('set_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.assessmentItemId, t.participantId] })],
);

export const attempts = lms.table('attempts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  assessmentItemId: uuid('assessment_item_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  attemptNo: smallint('attempt_no').notNull(),
  status: text('status').notNull().default('in_progress'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submitKind: text('submit_kind'),
  score: numeric('score', { precision: 8, scale: 2 }),
  maxScore: numeric('max_score', { precision: 8, scale: 2 }),
  pendingManual: integer('pending_manual').notNull().default(0),
  gradedAt: timestamp('graded_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  feedback: text('feedback'),
  eventCount: smallint('event_count').notNull().default(0),
});

export const attemptQuestions = lms.table(
  'attempt_questions',
  {
    tenantId: uuid('tenant_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    position: smallint('position').notNull(),
    assessmentItemId: uuid('assessment_item_id').notNull(),
    questionId: uuid('question_id').notNull(),
    questionVersionId: uuid('question_version_id').notNull(),
    scoredVersionId: uuid('scored_version_id').notNull(),
    points: numeric('points', { precision: 6, scale: 2 }).notNull(),
    optionOrder: text('option_order').array().notNull().default([]),
    answer: jsonb('answer'),
    rev: integer('rev').notNull().default(0),
    clientAt: bigint('client_at', { mode: 'number' }).notNull().default(0),
    flagged: boolean('flagged').notNull().default(false),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    spentMs: integer('spent_ms').notNull().default(0),
    score: numeric('score', { precision: 6, scale: 2 }),
    manualState: text('manual_state').notNull().default('na'),
    feedback: text('feedback'),
    gradedBy: uuid('graded_by'),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
    dropped: boolean('dropped').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.attemptId, t.position] })],
);

export const attemptEvents = lms.table(
  'attempt_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    n: smallint('n').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.attemptId, t.n] })],
);

export const regradeRuns = lms.table('regrade_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  assessmentItemId: uuid('assessment_item_id').notNull(),
  questionId: uuid('question_id').notNull(),
  action: text('action').notNull(),
  fromVersionId: uuid('from_version_id'),
  toVersionId: uuid('to_version_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  affectedAttempts: integer('affected_attempts').notNull().default(0),
});

export const regradeChanges = lms.table(
  'regrade_changes',
  {
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    beforeScore: numeric('before_score', { precision: 8, scale: 2 }),
    afterScore: numeric('after_score', { precision: 8, scale: 2 }),
    beforeMax: numeric('before_max', { precision: 8, scale: 2 }),
    afterMax: numeric('after_max', { precision: 8, scale: 2 }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.runId, t.attemptId] })],
);

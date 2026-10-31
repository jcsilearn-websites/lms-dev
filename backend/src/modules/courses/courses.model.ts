import { numeric, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

export const offeringStatus = lms.enum('offering_status', ['draft', 'published', 'archived']);
export const participationType = lms.enum('participation_type', [
  'instructor',
  'assistant',
  'learner',
]);
export const participantSource = lms.enum('participant_source', ['manual', 'section']);
export const participantStatus = lms.enum('participant_status', ['active', 'removed']);

// Migration 0016. The department is optional: colleges run cross-department electives and skill courses.
export const courses = lms.table('courses', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  credits: numeric('credits', { precision: 4, scale: 1 }),
  departmentId: uuid('department_id'),
  origin: text('origin').notNull().default('tenant'),
  sourceRef: text('source_ref'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const courseOfferings = lms.table('course_offerings', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  courseId: uuid('course_id').notNull(),
  termId: uuid('term_id').notNull(),
  label: text('label').notNull().default(''),
  titleOverride: text('title_override'),
  status: offeringStatus('status').notNull().default('draft'),
  copyStatus: text('copy_status').notNull().default('none'),
  // progress settings (migration 0026)
  completionThreshold: smallint('completion_threshold').notNull().default(90),
  behindAfterDays: smallint('behind_after_days').notNull().default(7),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const offeringSections = lms.table(
  'offering_sections',
  {
    tenantId: uuid('tenant_id').notNull(),
    offeringId: uuid('offering_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.offeringId, t.sectionId] })],
);

export const courseParticipants = lms.table('course_participants', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  participation: participationType('participation').notNull(),
  source: participantSource('source').notNull().default('manual'),
  sourceSectionId: uuid('source_section_id'),
  status: participantStatus('status').notNull().default('active'),
  removedReason: text('removed_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Members whose enrolment must be recomputed (filled by triggers, drained by the courses.sync job).
export const courseSyncPending = lms.table(
  'course_sync_pending',
  {
    tenantId: uuid('tenant_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.membershipId] })],
);

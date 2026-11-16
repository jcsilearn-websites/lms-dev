import {
  bigint,
  date,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { lms } from '../../db/lms-schema';

// Tables owned by the analytics module (migrations 0043 / 0044). All are written only by definer functions and triggers;
// the app reads them. Primary keys and foreign keys live in the migration (schema-drift compares columns).
export const memberActivityDays = lms.table('member_activity_days', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  day: date('day').notNull(),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
});

export const videoWatchDays = lms.table('video_watch_days', {
  tenantId: uuid('tenant_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  day: date('day').notNull(),
  seconds: integer('seconds').notNull(),
});

export const rollupDirtyParticipants = lms.table('rollup_dirty_participants', {
  tenantId: uuid('tenant_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rollupDirtyOfferings = lms.table('rollup_dirty_offerings', {
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rollupLearnerOffering = lms.table('rollup_learner_offering', {
  tenantId: uuid('tenant_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  userId: uuid('user_id').notNull(),
  totalRequired: integer('total_required').notNull(),
  completedRequired: integer('completed_required').notNull(),
  behindItems: integer('behind_items').notNull(),
  missedDeadlines: integer('missed_deadlines').notNull(),
  avgScore: numeric('avg_score', { precision: 5, scale: 2 }),
  scoredItems: integer('scored_items').notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(),
  videoSeconds: integer('video_seconds').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
});

export const rollupOfferingDay = lms.table('rollup_offering_day', {
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  day: date('day').notNull(),
  activeLearners: integer('active_learners').notNull(),
  itemsCompleted: integer('items_completed').notNull(),
  submissions: integer('submissions').notNull(),
  attempts: integer('attempts').notNull(),
  videoSeconds: integer('video_seconds').notNull(),
});

export const rollupOrgDay = lms.table('rollup_org_day', {
  tenantId: uuid('tenant_id').notNull(),
  scope: text('scope').notNull(),
  scopeId: uuid('scope_id').notNull(),
  day: date('day').notNull(),
  activeMembers: integer('active_members').notNull(),
});

export const rollupTenantDay = lms.table('rollup_tenant_day', {
  tenantId: uuid('tenant_id').notNull(),
  day: date('day').notNull(),
  activeUsers: integer('active_users').notNull(),
  activeLearners: integer('active_learners').notNull(),
  videoSeconds: bigint('video_seconds', { mode: 'number' }).notNull(),
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull(),
});

export const rollupState = lms.table('rollup_state', {
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  watermark: timestamp('watermark', { withTimezone: true }).notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  rowsWritten: integer('rows_written').notNull().default(0),
});

export const usageSnapshots = lms.table('usage_snapshots', {
  tenantId: uuid('tenant_id').notNull(),
  month: date('month').notNull(),
  revision: smallint('revision').notNull().default(1),
  timeZone: text('time_zone').notNull(),
  billableLearners: integer('billable_learners').notNull(),
  activeUsers: integer('active_users').notNull(),
  videoSeconds: bigint('video_seconds', { mode: 'number' }).notNull(),
  videoGbEstimate: numeric('video_gb_estimate', { precision: 14, scale: 3 }).notNull(),
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull(),
  offerings: integer('offerings').notNull(),
  activeOfferings: integer('active_offerings').notNull(),
  definition: jsonb('definition').notNull(),
  renditionMix: jsonb('rendition_mix').notNull(),
  reason: text('reason'),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
});

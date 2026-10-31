import { customType, integer, numeric, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { lms } from '../../db/lms-schema';

// Migration 0026. Progress is HISTORY: every foreign key is ON DELETE RESTRICT, nothing here is ever deleted by the app,
// and every write goes through the SECURITY DEFINER functions progress_heartbeat / progress_mark.

/** PostgreSQL 17 multirange of whole seconds, e.g. '{[0,30),[45,60)}' (kept as text here; the database merges it). */
const int4multirange = customType<{ data: string; driverData: string }>({
  dataType: () => 'int4multirange',
});

export const itemProgress = lms.table('item_progress', {
  tenantId: uuid('tenant_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  status: text('status').notNull().default('in_progress'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedHow: text('completed_how'),
  ranges: int4multirange('ranges').notNull().default('{}'),
  watchedSeconds: integer('watched_seconds').notNull().default(0),
  durationS: integer('duration_s'),
  positionS: integer('position_s').notNull().default(0),
  positionStream: uuid('position_stream'),
  lastSeq: integer('last_seq').notNull().default(0),
  rate: numeric('rate', { precision: 4, scale: 2 }),
  budgetS: real('budget_s').notNull().default(45),
  budgetAt: timestamp('budget_at', { withTimezone: true }).notNull().defaultNow(),
  suspicious: integer('suspicious').notNull().default(0),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
});

import { boolean, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

// Migration 0018. `position` is a fractional ordering key (COLLATE "C"): moving an entry rewrites one row.
export const contentModules = lms.table('content_modules', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  title: text('title').notNull(),
  position: text('position').notNull(),
  published: boolean('published').notNull().default(false),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  // archived with its items when something in it has learner progress (migration 0026)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contentItems = lms.table('content_items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  offeringId: uuid('offering_id').notNull(),
  moduleId: uuid('module_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  position: text('position').notNull(),
  body: jsonb('body'),
  fileId: uuid('file_id'),
  videoAssetId: uuid('video_asset_id'),
  url: text('url'),
  published: boolean('published').notNull().default(false),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  createdBy: uuid('created_by'),
  // required items count towards progress; completion: manual | on_view | watch (video)
  required: boolean('required').notNull().default(true),
  completion: text('completion').notNull(),
  // an item with learner progress is archived, not deleted (its progress is history)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Migration 0073: the answer of one offering-copy request, keyed by the client's request key (idempotency).
export const offeringCopyRequests = lms.table('offering_copy_requests', {
  tenantId: uuid('tenant_id').notNull(),
  requestKey: uuid('request_key').notNull(),
  targetOfferingId: uuid('target_offering_id').notNull(),
  sourceOfferingId: uuid('source_offering_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  shiftDays: integer('shift_days'),
  clearDates: boolean('clear_dates').notNull(),
  mode: text('mode').notNull(),
  modules: integer('modules').notNull(),
  items: integer('items').notNull(),
  assessments: integer('assessments').notNull(),
  assignments: integer('assignments').notNull(),
  createdAt: createdAt(),
});

import { boolean, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  url: text('url'),
  published: boolean('published').notNull().default(false),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

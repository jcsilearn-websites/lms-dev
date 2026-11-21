import { bigint, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { lms } from '../../db/lms-schema';

// One row per "download my data" request (migration 0062). lms_app can only SELECT (its own rows); every change is a definer function.
export const dataExports = lms.table('data_exports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  storageKey: text('storage_key'),
  counts: jsonb('counts'),
  error: text('error'),
});

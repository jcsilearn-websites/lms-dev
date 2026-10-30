import { bigint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms } from '../../db/lms-schema';

// Migration 0017. Metadata only: the bytes live in object storage.
export const files = lms.table('files', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storageKey: text('storage_key').notNull(),
  originalName: text('original_name').notNull(),
  contentType: text('content_type').notNull(),
  declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  status: text('status').notNull().default('pending'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastUnreferencedAt: timestamp('last_unreferenced_at', { withTimezone: true }),
});

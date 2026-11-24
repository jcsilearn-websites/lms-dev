import { integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, lms } from '../../db/lms-schema';

// Tables owned by the email module (migration 0052). lms_app has NO privilege on any of them: every read and write is a
// hardened definer function (email_enqueue_security, email_claim, email_mark, email_webhook_ingest, the suppression
// functions, email_outbox_purge). Keys, indexes and checks live in the migration (schema-drift compares columns).
export const emailOutbox = lms.table('email_outbox', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  userId: uuid('user_id'),
  toEmail: text('to_email').notNull(),
  category: text('category').notNull(),
  template: text('template').notNull(),
  params: jsonb('params').notNull(),
  status: text('status').notNull(),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  attempts: integer('attempts').notNull(),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  skipReason: text('skip_reason'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailSuppressions = lms.table('email_suppressions', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  reason: text('reason').notNull(),
  detail: text('detail'),
  provider: text('provider'),
  sourceTenantId: uuid('source_tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  clearedBy: uuid('cleared_by'),
  clearedInTenant: uuid('cleared_in_tenant'),
  // HMAC-SHA256 of the address under the key emailHashKid (migration 0064; core/keyed-hash.ts)
  emailHash: bytea('email_hash'),
  emailHashKid: text('email_hash_kid'),
});

export const emailEvents = lms.table('email_events', {
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  kind: text('kind').notNull(),
  email: text('email'),
  outboxId: uuid('outbox_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

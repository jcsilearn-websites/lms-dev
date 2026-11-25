import { bigint, boolean, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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

// One row per erasure request inside a college (migrations 0063 / 0064). lms_app can only SELECT.
export const erasureRequests = lms.table('erasure_requests', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull(),
  source: text('source').notNull().default('member'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  reason: text('reason'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  ledgerAt: timestamp('ledger_at', { withTimezone: true }),
  preview: jsonb('preview'),
  withAccount: boolean('with_account').notNull().default(false),
});

// One row per ACCOUNT erasure request (migrations 0066 / 0067). Global (no tenant): no grant for lms_app, definer functions only.
export const accountErasureRequests = lms.table('account_erasure_requests', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  source: text('source').notNull(),
  status: text('status').notNull(),
  collegeRequestId: uuid('college_request_id'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  requestedBy: uuid('requested_by'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  reason: text('reason'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  ledgerAt: timestamp('ledger_at', { withTimezone: true }),
});

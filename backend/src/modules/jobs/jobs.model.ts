import { integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms } from '../../db/lms-schema';

export const jobStatus = lms.enum('job_status', ['queued', 'running', 'completed', 'dead']);

// The queue. tenant_id NULL = system job. lms_app can SELECT / INSERT its own tenant's jobs only; the
// state transitions (claim, complete, fail, extend lease, release, purge) are SECURITY DEFINER functions.
export const jobs = lms.table('jobs', {
  id: uuid('id').primaryKey(),
  queue: text('queue').notNull(),
  tenantId: uuid('tenant_id'),
  payload: jsonb('payload').notNull().default({}),
  status: jobStatus('status').notNull().default('queued'),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lastError: text('last_error'),
  result: jsonb('result'),
  lockedBy: text('locked_by'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  singletonKey: text('singleton_key'),
  createdAt: createdAt(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

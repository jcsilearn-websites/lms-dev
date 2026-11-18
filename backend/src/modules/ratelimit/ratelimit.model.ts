import { integer, text, timestamp } from 'drizzle-orm/pg-core';
import { lms } from '../../db/lms-schema';

// UNLOGGED (emptied on a crash or failover on purpose, docs/adr/0022). No tenant: a limiter key is an address or a session hash.
// RLS enabled + forced, no policy, no grant for lms_app: only lms.rate_limit_hit / rate_limit_purge touch it.
export const rateLimitCounters = lms.table('rate_limit_counters', {
  key: text('key').primaryKey(),
  hits: integer('hits').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowMs: integer('window_ms').notNull(),
});

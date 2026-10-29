import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, inet, lms } from '../../db/lms-schema';

// tenant_id NULL = platform-admin session. Only the SHA-256 of the cookie token is stored.
export const sessions = lms.table('sessions', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

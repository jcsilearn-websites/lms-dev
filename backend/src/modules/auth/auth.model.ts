import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, lms, updatedAt } from '../../db/lms-schema';

// Neither table is readable by lms_app: both are reachable only through the SECURITY DEFINER
// functions in migration 0005 (see auth.repository.ts).
export const userCredentials = lms.table('user_credentials', {
  userId: uuid('user_id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authTokenPurpose = lms.enum('auth_token_purpose', ['invite', 'password_reset']);

export const authTokens = lms.table('auth_tokens', {
  id: uuid('id').primaryKey(),
  purpose: authTokenPurpose('purpose').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id'),
  membershipId: uuid('membership_id'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

import { bigint, boolean, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, inet, lms, updatedAt } from '../../db/lms-schema';

// None of these tables is readable by lms_app: they are reachable only through the SECURITY DEFINER
// functions (migrations 0005 / 0070; see auth.repository.ts and auth.mfa.repository.ts).
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

export const authTokenPurpose = lms.enum('auth_token_purpose', [
  'invite',
  'password_reset',
  'mfa_enrol',
]);

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

// two-factor sign-in (step 14c)
export const userMfa = lms.table('user_mfa', {
  userId: uuid('user_id').primaryKey(),
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  secretNonce: bytea('secret_nonce').notNull(),
  keyId: text('key_id').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull(),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }).notNull(),
  totpFailures: integer('totp_failures').notNull().default(0),
  totpLockedUntil: timestamp('totp_locked_until', { withTimezone: true }),
  totpLockReported: boolean('totp_lock_reported').notNull().default(false),
  recoveryFailures: integer('recovery_failures').notNull().default(0),
  recoveryLockedUntil: timestamp('recovery_locked_until', { withTimezone: true }),
  updatedAt: updatedAt(),
});

export const mfaResetRequests = lms.table('mfa_reset_requests', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  requestedBy: uuid('requested_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  executeAfter: timestamp('execute_after', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by'),
  reason: text('reason'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
});

export const userMfaRecoveryCodes = lms.table('user_mfa_recovery_codes', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  codeHash: bytea('code_hash').notNull(),
  keyId: text('key_id').notNull(),
  createdAt: createdAt(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const authMfaChallenges = lms.table('auth_mfa_challenges', {
  id: uuid('id').primaryKey(),
  tokenHash: bytea('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id'),
  purpose: text('purpose').notNull(),
  totpAttempts: integer('totp_attempts').notNull().default(0),
  recoveryAttempts: integer('recovery_attempts').notNull().default(0),
  enrolTokenId: uuid('enrol_token_id'),
  pendingCiphertext: bytea('pending_ciphertext'),
  pendingNonce: bytea('pending_nonce'),
  pendingKeyId: text('pending_key_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

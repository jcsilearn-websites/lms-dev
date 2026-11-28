import { sql } from 'drizzle-orm';
import type { RecoveryHash, SealedSecret } from '../../core/mfa-crypto';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';

// SQL only (two-factor sign-in, step 14c). user_mfa, the recovery codes and the challenges are NOT readable by lms_app: every
// function here calls a SECURITY DEFINER function (migration 0070) on a no-tenant executor. One call = one statement = one round
// trip. Every time decision takes `now` from the caller.

export interface SessionInput {
  sessionId: string;
  tokenHash: Buffer;
  idleSeconds: number;
  absoluteSeconds: number;
  ip: string | null;
  userAgent: string | null;
}

/** The signed-in session an action is made from. */
export interface SessionRef {
  userId: string;
  sessionId: string;
  tenantId: string | null;
  ip: string | null;
}

export interface SignedIn {
  userId: string;
  email: string;
  displayName: string;
  role: 'institution_admin' | 'member' | null;
  isPlatformAdmin: boolean;
  expiresAt: Date;
}

interface SignedInRow {
  r_status: string;
  r_user_id: string;
  r_email: string;
  r_display_name: string;
  r_role: SignedIn['role'];
  r_is_platform_admin: boolean;
  r_expires_at: Date | string;
  r_retry_after?: number;
}

const signedIn = (r: SignedInRow): SignedIn => ({
  userId: r.r_user_id,
  email: r.r_email,
  displayName: r.r_display_name,
  role: r.r_role,
  isPlatformAdmin: r.r_is_platform_admin,
  expiresAt: new Date(r.r_expires_at),
});

export interface SecretAttempt {
  userId: string;
  sealed: SealedSecret;
}

interface SecretRow {
  r_status: 'ok' | 'invalid' | 'locked';
  r_user_id: string;
  r_ciphertext: Buffer;
  r_nonce: Buffer;
  r_key_id: string;
  r_retry_after?: number;
}

const secretOf = (r: SecretRow): SecretAttempt => ({
  userId: r.r_user_id,
  sealed: { kid: r.r_key_id, nonce: r.r_nonce, ciphertext: r.r_ciphertext },
});

export function createMfaRepository() {
  return {
    async challengeCreate(
      db: Executor,
      a: {
        id: string;
        tokenHash: Buffer;
        userId: string;
        tenantId: string | null;
        ttlSeconds: number;
        ip: string | null;
        userAgent: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.mfa_challenge_create(${a.id}::uuid, ${a.tokenHash}::bytea, ${a.userId}::uuid, ${a.tenantId}::uuid, ${a.ttlSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    async enrolLinkRequested(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        key: string;
        auditId: string;
        ip: string | null;
      },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.mfa_enrol_link_requested(${a.userId}::uuid, ${a.tenantId}::uuid, ${a.key}::text, ${a.auditId}::uuid, ${a.ip}::inet) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    async enrolLookup(db: Executor, tokenHash: Buffer, tenantId: string | null, now: Date) {
      const res = await db.execute(
        sql`select * from lms.mfa_enrol_lookup(${tokenHash}::bytea, ${tenantId}::uuid, ${now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as
        | {
            r_user_id: string;
            r_email: string;
            r_password_hash: string;
            r_locked_until: Date | string | null;
          }
        | undefined;
      return (
        r && {
          userId: r.r_user_id,
          email: r.r_email,
          passwordHash: r.r_password_hash,
          lockedUntil: r.r_locked_until === null ? null : new Date(r.r_locked_until),
        }
      );
    },

    async enrolStart(
      db: Executor,
      a: {
        tokenHash: Buffer;
        tenantId: string | null;
        id: string;
        challengeHash: Buffer;
        sealed: SealedSecret;
        ttlSeconds: number;
        ip: string | null;
        userAgent: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.mfa_enrol_start(${a.tokenHash}::bytea, ${a.tenantId}::uuid, ${a.id}::uuid, ${a.challengeHash}::bytea, ${a.sealed.ciphertext}::bytea, ${a.sealed.nonce}::bytea, ${a.sealed.kid}::text, ${a.ttlSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    /** Charges one confirmation try; null = the challenge cannot be used (any more). */
    async enrolAttempt(
      db: Executor,
      a: {
        challengeHash: Buffer;
        tenantId: string | null;
        max: number;
        ip: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<SecretAttempt | null> {
      const res = await db.execute(
        sql`select * from lms.mfa_enrol_attempt(${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.max}::int, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as unknown as SecretRow;
      return r.r_status === 'ok' ? secretOf(r) : null;
    },

    async enrolComplete(
      db: Executor,
      a: SessionInput & {
        challengeHash: Buffer;
        tenantId: string | null;
        step: number;
        codeIds: string[];
        codes: RecoveryHash[];
        auditId: string;
        loginAuditId: string;
        now: Date;
      },
    ): Promise<SignedIn | null> {
      // bytea[] as hex text: pgArray quotes every element, and `\x..` is the input format of bytea
      const hashes = pgArray(a.codes.map((c) => `\\x${c.hash.toString('hex')}`));
      const res = await db.execute(
        sql`select * from lms.mfa_enrol_complete(${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.step}::bigint, ${pgArray(a.codeIds)}::uuid[], ${hashes}::bytea[], ${a.codes[0]?.kid ?? ''}::text, ${a.sessionId}::uuid, ${a.tokenHash}::bytea, ${a.idleSeconds}::int, ${a.absoluteSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.loginAuditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as unknown as SignedInRow;
      return r.r_status === 'ok' ? signedIn(r) : null;
    },

    async totpAttempt(
      db: Executor,
      a: {
        challengeHash: Buffer;
        tenantId: string | null;
        maxPerChallenge: number;
        ip: string | null;
        auditId: string;
        lockAuditId: string;
        now: Date;
      },
    ): Promise<
      | ({ status: 'ok' } & SecretAttempt)
      | { status: 'invalid' }
      | { status: 'locked'; retryAfterSeconds: number }
    > {
      const res = await db.execute(
        sql`select * from lms.mfa_totp_attempt(${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.maxPerChallenge}::int, ${a.ip}::inet, ${a.auditId}::uuid, ${a.lockAuditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as unknown as SecretRow;
      if (r.r_status === 'ok') return { status: 'ok', ...secretOf(r) };
      if (r.r_status === 'locked') {
        return { status: 'locked', retryAfterSeconds: r.r_retry_after ?? 0 };
      }
      return { status: 'invalid' };
    },

    async totpAccept(
      db: Executor,
      a: SessionInput & {
        challengeHash: Buffer;
        tenantId: string | null;
        step: number;
        auditId: string;
        now: Date;
      },
    ): Promise<{ status: 'ok'; signedIn: SignedIn } | { status: 'invalid' | 'replayed' }> {
      const res = await db.execute(
        sql`select * from lms.mfa_totp_accept(${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.step}::bigint, ${a.sessionId}::uuid, ${a.tokenHash}::bytea, ${a.idleSeconds}::int, ${a.absoluteSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as unknown as SignedInRow;
      if (r.r_status === 'ok') return { status: 'ok', signedIn: signedIn(r) };
      return { status: r.r_status === 'replayed' ? 'replayed' : 'invalid' };
    },

    async recoveryUse(
      db: Executor,
      a: SessionInput & {
        challengeHash: Buffer;
        tenantId: string | null;
        candidates: RecoveryHash[];
        maxPerChallenge: number;
        auditId: string;
        loginAuditId: string;
        now: Date;
      },
    ): Promise<
      | { status: 'ok'; signedIn: SignedIn }
      | { status: 'invalid' | 'wrong' }
      | { status: 'locked'; retryAfterSeconds: number }
    > {
      const hashes = pgArray(a.candidates.map((c) => `\\x${c.hash.toString('hex')}`));
      const kids = pgArray(a.candidates.map((c) => c.kid));
      const res = await db.execute(
        sql`select * from lms.mfa_recovery_use(${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${hashes}::bytea[], ${kids}::text[], ${a.maxPerChallenge}::int, ${a.sessionId}::uuid, ${a.tokenHash}::bytea, ${a.idleSeconds}::int, ${a.absoluteSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.loginAuditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as unknown as SignedInRow;
      if (r.r_status === 'ok') return { status: 'ok', signedIn: signedIn(r) };
      if (r.r_status === 'locked') {
        return { status: 'locked', retryAfterSeconds: r.r_retry_after ?? 0 };
      }
      return { status: r.r_status === 'wrong' ? 'wrong' : 'invalid' };
    },

    async status(db: Executor, userId: string) {
      const res = await db.execute(sql`select * from lms.mfa_status(${userId}::uuid)`);
      const r = res.rows[0] as {
        r_enrolled_at: Date | string | null;
        r_recovery_remaining: number;
        r_can_disable: boolean;
      };
      return {
        enrolledAt: r.r_enrolled_at === null ? null : new Date(r.r_enrolled_at),
        recoveryCodesRemaining: r.r_recovery_remaining,
        canDisable: r.r_can_disable,
      };
    },

    // ---- step-up (the person is signed in)

    async stepUpAttempt(
      db: Executor,
      a: SessionRef & { auditId: string; lockAuditId: string; now: Date },
    ): Promise<
      | { status: 'ok'; sealed: SealedSecret }
      | { status: 'invalid' | 'not_enrolled' }
      | { status: 'locked'; retryAfterSeconds: number }
    > {
      const res = await db.execute(
        sql`select * from lms.mfa_stepup_attempt(${a.userId}::uuid, ${a.sessionId}::uuid, ${a.tenantId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid, ${a.lockAuditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as {
        r_status: 'ok' | 'invalid' | 'not_enrolled' | 'locked';
        r_ciphertext: Buffer;
        r_nonce: Buffer;
        r_key_id: string;
        r_retry_after: number;
      };
      if (r.r_status === 'ok') {
        return {
          status: 'ok',
          sealed: { kid: r.r_key_id, nonce: r.r_nonce, ciphertext: r.r_ciphertext },
        };
      }
      if (r.r_status === 'locked') return { status: 'locked', retryAfterSeconds: r.r_retry_after };
      return { status: r.r_status };
    },

    async stepUpAccept(
      db: Executor,
      a: SessionRef & { step: number; auditId: string; now: Date },
    ): Promise<'ok' | 'replayed' | 'invalid'> {
      const res = await db.execute(
        sql`select lms.mfa_stepup_accept(${a.userId}::uuid, ${a.sessionId}::uuid, ${a.tenantId}::uuid, ${a.step}::bigint, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as s`,
      );
      return (res.rows[0] as { s: 'ok' | 'replayed' | 'invalid' }).s;
    },

    async stepUpRecovery(
      db: Executor,
      a: SessionRef & { candidates: RecoveryHash[]; auditId: string; now: Date },
    ): Promise<
      | { status: 'ok' | 'wrong' | 'invalid' | 'not_enrolled' }
      | { status: 'locked'; retryAfterSeconds: number }
    > {
      const hashes = pgArray(a.candidates.map((c) => `\\x${c.hash.toString('hex')}`));
      const kids = pgArray(a.candidates.map((c) => c.kid));
      const res = await db.execute(
        sql`select * from lms.mfa_stepup_recovery(${a.userId}::uuid, ${a.sessionId}::uuid, ${a.tenantId}::uuid, ${hashes}::bytea[], ${kids}::text[], ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as {
        r_status: 'ok' | 'wrong' | 'invalid' | 'not_enrolled' | 'locked';
        r_retry_after: number;
      };
      return r.r_status === 'locked'
        ? { status: 'locked', retryAfterSeconds: r.r_retry_after }
        : { status: r.r_status };
    },

    // ---- the person's own factor

    async regenerateCodes(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        codeIds: string[];
        codes: RecoveryHash[];
        ip: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<boolean> {
      const hashes = pgArray(a.codes.map((c) => `\\x${c.hash.toString('hex')}`));
      const res = await db.execute(
        sql`select lms.mfa_recovery_regenerate(${a.userId}::uuid, ${a.tenantId}::uuid, ${pgArray(a.codeIds)}::uuid[], ${hashes}::bytea[], ${a.codes[0]?.kid ?? ''}::text, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    async replaceStart(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        id: string;
        challengeHash: Buffer;
        sealed: SealedSecret;
        ttlSeconds: number;
        ip: string | null;
        userAgent: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.mfa_replace_start(${a.userId}::uuid, ${a.tenantId}::uuid, ${a.id}::uuid, ${a.challengeHash}::bytea, ${a.sealed.ciphertext}::bytea, ${a.sealed.nonce}::bytea, ${a.sealed.kid}::text, ${a.ttlSeconds}::int, ${a.ip}::inet, ${a.userAgent}::text, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    /** Charges one try of the pending secret; null = the setup cannot be used (any more). */
    async replaceAttempt(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        challengeHash: Buffer;
        max: number;
        ip: string | null;
        auditId: string;
        now: Date;
      },
    ): Promise<SealedSecret | null> {
      const res = await db.execute(
        sql`select * from lms.mfa_replace_attempt(${a.userId}::uuid, ${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.max}::int, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz)`,
      );
      const r = res.rows[0] as {
        r_status: 'ok' | 'invalid';
        r_ciphertext: Buffer;
        r_nonce: Buffer;
        r_key_id: string;
      };
      return r.r_status === 'ok'
        ? { kid: r.r_key_id, nonce: r.r_nonce, ciphertext: r.r_ciphertext }
        : null;
    },

    async replaceComplete(
      db: Executor,
      a: SessionRef & { challengeHash: Buffer; step: number; auditId: string; now: Date },
    ): Promise<boolean> {
      const res = await db.execute(
        sql`select lms.mfa_replace_complete(${a.userId}::uuid, ${a.challengeHash}::bytea, ${a.tenantId}::uuid, ${a.step}::bigint, ${a.sessionId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as ok`,
      );
      return (res.rows[0] as { ok: boolean }).ok;
    },

    async disable(
      db: Executor,
      a: SessionRef & { auditId: string; now: Date },
    ): Promise<'ok' | 'required' | 'not_enrolled'> {
      const res = await db.execute(
        sql`select lms.mfa_disable(${a.userId}::uuid, ${a.tenantId}::uuid, ${a.sessionId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid, ${a.now.toISOString()}::timestamptz) as s`,
      );
      return (res.rows[0] as { s: 'ok' | 'required' | 'not_enrolled' }).s;
    },

    async purgeChallenges(db: Executor, batch: number): Promise<number> {
      const res = await db.execute(sql`select lms.auth_purge_mfa_challenges(${batch}::int) as n`);
      return Number((res.rows[0] as { n: number }).n);
    },
  };
}
export type MfaRepository = ReturnType<typeof createMfaRepository>;

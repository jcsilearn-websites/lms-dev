import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';

// SQL only. user_credentials and auth_tokens are NOT readable by lms_app: every function here calls a
// SECURITY DEFINER function (migrations 0005/0006) on a no-tenant executor (db.withoutTenant).
// One function call = one statement = one round trip.

// Drizzle's raw execute() hands timestamps back as strings: normalise them to Date here.
const toDate = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

/** Everything login needs before verifying the password (see lms.auth_login_begin). */
export interface LoginBegin {
  /** null = no such account (or no credentials yet) */
  userId: string | null;
  passwordHash: string | null;
  lockedUntil: Date | null;
  isPlatformAdmin: boolean;
  /** null on the admin host (no tenant); otherwise the CURRENT status, never a cached one */
  tenantActive: boolean | null;
  membershipRole: 'institution_admin' | 'member' | null;
  membershipStatus: 'active' | 'pending' | null;
}

export interface LoginRecord {
  userId: string;
  passwordHash: string;
  lockedUntil: Date | null;
  isPlatformAdmin: boolean;
}

export type AcceptInviteStatus = 'ok' | 'invalid' | 'password_required';

export interface CreateTokenInput {
  id: string;
  purpose: 'invite' | 'password_reset';
  tokenHash: Buffer;
  userId: string;
  tenantId: string | null;
  membershipId: string | null;
  ttlSeconds: number;
  createdBy: string | null;
}

export function createAuthRepository() {
  return {
    /** Login step 1: tenant status + account + credentials + membership in ONE statement. */
    async loginBegin(db: Executor, email: string, tenantId: string | null): Promise<LoginBegin> {
      const res = await db.execute(
        sql`select * from lms.auth_login_begin(${email}::text, ${tenantId}::uuid)`,
      );
      const r = res.rows[0] as {
        r_user_id: string | null;
        r_password_hash: string | null;
        r_locked_until: Date | string | null;
        r_is_platform_admin: boolean | null;
        r_tenant_active: boolean | null;
        r_membership_role: LoginBegin['membershipRole'];
        r_membership_status: LoginBegin['membershipStatus'];
      };
      return {
        userId: r.r_user_id,
        passwordHash: r.r_password_hash,
        lockedUntil: toDate(r.r_locked_until),
        isPlatformAdmin: r.r_is_platform_admin ?? false,
        tenantActive: r.r_tenant_active,
        membershipRole: r.r_membership_role,
        membershipStatus: r.r_membership_status,
      };
    },

    /**
     * A failed login: counts a wrong password (not while locked) and writes the audit entries
     * (login_failed, plus account_locked when this failure locked the account), in ONE statement.
     */
    async loginFailed(
      db: Executor,
      a: {
        userId: string;
        tenantId: string | null;
        countAttempt: boolean;
        reason: string;
        maxAttempts: number;
        baseSeconds: number;
        maxSeconds: number;
        ip: string | null;
        auditId: string;
        lockAuditId: string;
      },
    ): Promise<{ failedAttempts: number; justLocked: boolean }> {
      const res = await db.execute(
        sql`select * from lms.auth_login_failed(${a.userId}::uuid, ${a.tenantId}::uuid, ${a.countAttempt}::boolean, ${a.reason}::text, ${a.maxAttempts}::int, ${a.baseSeconds}::int, ${a.maxSeconds}::int, ${a.ip}::inet, ${a.auditId}::uuid, ${a.lockAuditId}::uuid)`,
      );
      const r = res.rows[0] as { r_failed_attempts: number; r_just_locked: boolean };
      return { failedAttempts: r.r_failed_attempts, justLocked: r.r_just_locked };
    },

    /** Used by forgot-password and change-password (lookup by email). */
    async findLogin(db: Executor, email: string): Promise<LoginRecord | undefined> {
      const res = await db.execute(
        sql`select user_id, password_hash, locked_until, is_platform_admin from lms.auth_find_login(${email}::text)`,
      );
      const r = res.rows[0] as
        | {
            user_id: string;
            password_hash: string;
            locked_until: Date | string | null;
            is_platform_admin: boolean;
          }
        | undefined;
      return (
        r && {
          userId: r.user_id,
          passwordHash: r.password_hash,
          lockedUntil: toDate(r.locked_until),
          isPlatformAdmin: r.is_platform_admin,
        }
      );
    },

    async clearFailures(db: Executor, userId: string): Promise<void> {
      await db.execute(sql`select lms.auth_clear_failures(${userId}::uuid)`);
    },

    /** Sets/creates the password hash and clears failed attempts and any lock (login rehash). */
    async setPassword(db: Executor, userId: string, passwordHash: string): Promise<void> {
      await db.execute(sql`select lms.auth_set_password(${userId}::uuid, ${passwordHash}::text)`);
    },

    /**
     * Redeems a reset token, sets the password (clears any lock), revokes every session and audits,
     * atomically. undefined = unknown/used/expired token.
     */
    async resetPassword(
      db: Executor,
      a: {
        tokenHash: Buffer;
        passwordHash: string;
        tenantId: string | null;
        ip: string | null;
        auditId: string;
      },
    ): Promise<string | undefined> {
      const res = await db.execute(
        sql`select r_user_id from lms.auth_reset_password(${a.tokenHash}::bytea, ${a.passwordHash}::text, ${a.tenantId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid)`,
      );
      return (res.rows[0] as { r_user_id: string } | undefined)?.r_user_id;
    },

    /** Sets the new password, revokes the user's other sessions and audits, in ONE statement. */
    async changePassword(
      db: Executor,
      a: {
        userId: string;
        passwordHash: string;
        exceptSessionId: string;
        tenantId: string | null;
        ip: string | null;
        auditId: string;
      },
    ): Promise<void> {
      await db.execute(
        sql`select lms.auth_change_password(${a.userId}::uuid, ${a.passwordHash}::text, ${a.exceptSessionId}::uuid, ${a.tenantId}::uuid, ${a.ip}::inet, ${a.auditId}::uuid)`,
      );
    },

    async createToken(db: Executor, t: CreateTokenInput): Promise<void> {
      await db.execute(
        sql`select lms.auth_create_token(${t.id}::uuid, ${t.purpose}::text, ${t.tokenHash}::bytea, ${t.userId}::uuid, ${t.tenantId}::uuid, ${t.membershipId}::uuid, ${t.ttlSeconds}::int, ${t.createdBy}::uuid)`,
      );
    },

    /**
     * Resend an invite in ONE statement: lock the membership, issue a fresh token for it (this voids
     * the previous unused invite token, see auth_create_token) and write the audit entry. The token is
     * issued only while the membership is still pending. Returns null when there is no such member.
     */
    async resendInvite(
      tx: Executor,
      a: {
        tenantId: string;
        userId: string;
        tokenId: string;
        tokenHash: Buffer;
        ttlSeconds: number;
        actorUserId: string;
        auditId: string;
      },
    ): Promise<{ status: string; email: string; issued: boolean } | null> {
      const audit = auditInsertFrom(
        {
          id: a.auditId,
          tenantId: a.tenantId,
          actorUserId: a.actorUserId,
          action: 'member.invite_resent',
          targetType: 'membership',
        },
        {
          from: sql`m WHERE m.status = 'pending'`,
          targetId: sql`m.id::text`,
          metadata: sql`jsonb_build_object('userId', m.user_id, 'role', m.role)`,
        },
      );
      const res = await tx.execute(sql`
        WITH m AS (
          SELECT mm.id, mm.user_id, mm.role, mm.status, u.email
            FROM lms.tenant_memberships mm JOIN lms.users u ON u.id = mm.user_id
           WHERE mm.tenant_id = ${a.tenantId}::uuid AND mm.user_id = ${a.userId}::uuid
             FOR UPDATE OF mm
        ), tok AS (
          SELECT lms.auth_create_token(${a.tokenId}::uuid, 'invite', ${a.tokenHash}::bytea, m.user_id,
                                       ${a.tenantId}::uuid, m.id, ${a.ttlSeconds}::int, ${a.actorUserId}::uuid) AS id
            FROM m WHERE m.status = 'pending'
        ), aud AS (${audit})
        SELECT m.status::text AS status, m.email, (SELECT count(*) FROM tok) AS issued FROM m`);
      const r = res.rows[0] as
        | { status: string; email: string; issued: string | number }
        | undefined;
      return r ? { status: r.status, email: r.email, issued: Number(r.issued) > 0 } : null;
    },

    /** The slug, status and email of a membership, for the queued invite email (one statement). */
    async inviteTarget(
      tx: Executor,
      tenantId: string,
      membershipId: string,
    ): Promise<{ slug: string; status: string; email: string; userId: string } | null> {
      const res = await tx.execute(sql`
        SELECT t.slug, m.status::text AS status, u.email, m.user_id
          FROM lms.tenant_memberships m
          JOIN lms.tenants t ON t.id = m.tenant_id
          JOIN lms.users u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId}::uuid AND m.id = ${membershipId}::uuid`);
      const r = res.rows[0] as
        | { slug: string; status: string; email: string; user_id: string }
        | undefined;
      return r ? { slug: r.slug, status: r.status, email: r.email, userId: r.user_id } : null;
    },

    async acceptInvite(
      db: Executor,
      args: { tokenHash: Buffer; expectedTenantId: string | null; passwordHash: string | null },
    ): Promise<{ status: AcceptInviteStatus; userId: string | null; tenantId: string | null }> {
      const res = await db.execute(
        sql`select r_status, r_user_id, r_tenant_id from lms.auth_accept_invite(${args.tokenHash}::bytea, ${args.expectedTenantId}::uuid, ${args.passwordHash}::text)`,
      );
      const r = res.rows[0] as {
        r_status: AcceptInviteStatus;
        r_user_id: string | null;
        r_tenant_id: string | null;
      };
      return { status: r.r_status, userId: r.r_user_id, tenantId: r.r_tenant_id };
    },

    /** Bounded purge of used/expired tokens older than the retention period; returns rows deleted. */
    async purgeTokens(db: Executor, retentionDays: number, batch: number): Promise<number> {
      const res = await db.execute(
        sql`select lms.auth_purge_tokens(${retentionDays}::int, ${batch}::int) as n`,
      );
      return Number((res.rows[0] as { n: number }).n);
    },
  };
}
export type AuthRepository = ReturnType<typeof createAuthRepository>;

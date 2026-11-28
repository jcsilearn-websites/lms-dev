import { isMembershipRole, type MeResponse } from '../../contracts';
import { ALL_PERMISSIONS, can } from '../../core/authz';
import type { BackgroundTasks } from '../../core/background';
import type { ClientInfo, RequestContext } from '../../core/context';
import { assertValidEmail, normalizeEmail } from '../../core/email';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors';
import type { PasswordHasher } from '../../core/password';
import { generateToken, hashToken } from '../../core/tokens';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import type { AuditService } from '../audit';
import {
  MemberNotFoundError,
  MemberNotPendingError,
  type MembershipsService,
} from '../memberships';
import type { SessionsService } from '../sessions';
import type { UsersService } from '../users';
import {
  InvalidCredentialsError,
  InvalidCurrentPasswordError,
  InvalidTokenError,
  PasswordRequiredError,
} from './auth.errors';
import { MFA_ENROL_LINK_TTL_SECONDS, type MfaService } from './auth.mfa.service';
import { assertPasswordAllowed } from './auth.password-policy';
import type { AuthRepository } from './auth.repository';

export interface AuthConfig {
  maxAttempts: number;
  lockBaseSeconds: number;
  /** Upper bound of a lock (15 minutes by default) so nobody can be locked out for long. */
  lockMaxSeconds: number;
  inviteTtlSeconds: number;
  resetTtlSeconds: number;
}

/** The `me` answer of a signed-in person (also what /auth/mfa/verify and the enrolment answer with). */
export function meResponse(args: {
  user: { id: string; email: string; displayName: string };
  tenant: { id: string; slug: string } | null;
  role: MeResponse['role'];
  isPlatformAdmin: boolean;
}): MeResponse {
  const subject = {
    userId: args.user.id,
    tenantId: args.tenant?.id ?? null,
    role: args.role,
    isPlatformAdmin: args.isPlatformAdmin,
  };
  return {
    user: args.user,
    tenant: args.tenant ? { id: args.tenant.id, slug: args.tenant.slug } : null,
    role: args.role,
    isPlatformAdmin: args.isPlatformAdmin,
    // account-level permissions only (course participation is resolved per course); UI hint, not enforcement
    permissions: ALL_PERMISSIONS.filter((p) => can(subject, p)),
  };
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  maxAttempts: 10,
  lockBaseSeconds: 60,
  lockMaxSeconds: 900,
  inviteTtlSeconds: 7 * 24 * 3600,
  resetTtlSeconds: 30 * 60,
};

/** Where a request landed: a tenant host or the platform admin host. */
export interface HostScope {
  tenant: { id: string; slug: string } | null;
  /** Validated origin for links in emails, e.g. https://alpha.example.com */
  origin: string;
}

export interface SessionStarted {
  kind: 'session';
  token: string;
  expiresAt: Date;
  me: MeResponse;
}

/** Signed in, or: the password was right but there is no session yet (step 14c). */
export type LoginResult =
  | SessionStarted
  | { kind: 'challenge'; step: 'totp'; challengeToken: string }
  | { kind: 'challenge'; step: 'enrol_email' };

export function createAuthService(deps: {
  db: Pick<Database, 'withoutTenant' | 'withTenant'>;
  authRepo: AuthRepository;
  hasher: PasswordHasher;
  /** Security mail goes through the outbox (step 13): one definer call, mandatory, never a token in the row. */
  securityMail: {
    enqueue(o: {
      tenantId: string | null;
      userId: string;
      template: 'invite' | 'password_reset';
      params: Record<string, unknown>;
      key: string;
    }): Promise<boolean>;
  };
  background: BackgroundTasks;
  sessionsService: Pick<SessionsService, 'completeLogin' | 'logout'>;
  usersService: Pick<UsersService, 'ensureUser'>;
  membershipsService: Pick<MembershipsService, 'getMembership' | 'invite'>;
  auditService: Pick<AuditService, 'recordIn'>;
  config?: Partial<AuthConfig>;
  /**
   * Two-factor sign-in (step 14c). Without it nobody is challenged, and the database still refuses a password-only session to a
   * person who has a factor (auth_login_complete): leaving it out can only fail closed.
   */
  secondFactor?: Pick<MfaService, 'enforced' | 'afterPassword'>;
}) {
  const { db, authRepo, hasher, securityMail, background, sessionsService, usersService } = deps;
  const { membershipsService, auditService, secondFactor } = deps;
  const config: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...deps.config };
  // Per instance, an optimisation only (the database decides): a logical clock and "user -> the tick at
  // which this instance saw the account get locked". A request that started before that tick read a stale
  // lockout; one that started after it reads the real one from the database.
  let lockClock = 0;
  const lockSeen = new Map<string, number>();

  return {
    /**
     * Email + password login on a tenant host (requires an ACTIVE membership) or on the admin host
     * (requires is_platform_admin). Two database statements on success: `auth_login_begin` (tenant
     * status, account, credentials, membership) and, after the argon2 check, `auth_login_complete`
     * (clear failures, create session, audit). Every failure is the same InvalidCredentialsError and
     * a verification always runs (a dummy hash for unknown emails); a failure is counted in ONE
     * statement BEFORE the 401 is returned (a known account costs one statement more than an unknown one;
     * the argon2 verify dominates the time and runs either way).
     */
    async login(input: {
      email: string;
      password: string;
      tenant: { id: string; slug: string } | null;
      client: ClientInfo;
    }): Promise<LoginResult> {
      const email = normalizeEmail(input.email);
      const tenantId = input.tenant?.id ?? null;
      const startedAt = ++lockClock; // ordered before this request's read of the lockout
      const begin = await db.withoutTenant((exec) => authRepo.loginBegin(exec, email, tenantId));

      // the plugin's slug cache may be up to a minute stale: the database says what is true now
      if (input.tenant && begin.tenantActive !== true) {
        throw new NotFoundError('tenant_not_found', 'Tenant not found');
      }

      // a reset of the second factor invalidates the password: the stored value is not a hash, so the account answers (and
      // takes the time) like an unknown one until a new password is chosen
      const known =
        begin.userId !== null && begin.passwordHash !== null && !begin.passwordHash.startsWith('!');
      // A guess that read the account before another guess locked it, and only now gets its hashing slot,
      // is dropped without argon2 work (it counts as "while locked": not counted, never a success).
      const lockedMeanwhile = () =>
        known && (lockSeen.get(begin.userId as string) ?? 0) > startedAt;
      const passwordOk = known
        ? await hasher.verify(begin.passwordHash as string, input.password, lockedMeanwhile)
        : await hasher.verifyDummy(input.password);
      const locked =
        (!!begin.lockedUntil && begin.lockedUntil.getTime() > Date.now()) || lockedMeanwhile();
      const allowedHere = input.tenant
        ? begin.membershipStatus === 'active'
        : begin.isPlatformAdmin;

      if (!known || !passwordOk || locked || !allowedHere) {
        if (known && !locked) {
          const userId = begin.userId as string;
          const wrongPassword = !passwordOk;
          // Counted BEFORE the 401 goes out (one statement, row-locked in the database): a client that has
          // an answer has also been counted, so it cannot out-run the bookkeeping. Only wrong passwords
          // count towards the lockout; attempts while locked are ignored.
          const failed = await db.withoutTenant((exec) =>
            authRepo.loginFailed(exec, {
              userId,
              tenantId,
              countAttempt: wrongPassword,
              reason: wrongPassword ? 'bad_password' : 'no_membership',
              maxAttempts: config.maxAttempts,
              baseSeconds: config.lockBaseSeconds,
              maxSeconds: config.lockMaxSeconds,
              ip: input.client.ip,
              auditId: newId(),
              lockAuditId: newId(),
            }),
          );
          if (failed.justLocked) {
            lockSeen.delete(userId);
            lockSeen.set(userId, ++lockClock);
            if (lockSeen.size > 1000) lockSeen.delete(lockSeen.keys().next().value as string);
          }
        }
        throw new InvalidCredentialsError();
      }

      const userId = begin.userId as string;
      // transparent rehash when the stored hash uses older parameters (rare: its own statement)
      if (hasher.needsRehash(begin.passwordHash as string)) {
        const newHash = await hasher.hash(input.password);
        await db.withoutTenant((exec) => authRepo.setPassword(exec, userId, newHash));
      }

      // two-factor sign-in: an enrolled person, or one who must enrol, gets NO session from the password
      const mustEnrol =
        secondFactor?.enforced === true &&
        (input.tenant ? begin.membershipRole === 'institution_admin' : begin.isPlatformAdmin);
      if (secondFactor && (begin.mfaEnrolled || mustEnrol)) {
        const next = await secondFactor.afterPassword({
          userId,
          enrolled: begin.mfaEnrolled,
          tenantId,
          client: input.client,
        });
        if (!next) throw new InvalidCredentialsError(); // changed in the meantime
        return { kind: 'challenge', ...next };
      }

      const session = await sessionsService.completeLogin({
        userId,
        tenantId,
        ip: input.client.ip,
        userAgent: input.client.userAgent,
      });
      if (!session) throw new InvalidCredentialsError(); // membership/tenant changed in the meantime

      return {
        kind: 'session',
        token: session.token,
        expiresAt: session.expiresAt,
        me: meResponse({
          user: { id: userId, email, displayName: session.displayName },
          tenant: input.tenant,
          role: session.role,
          isPlatformAdmin: begin.isPlatformAdmin,
        }),
      };
    },

    /** Revokes the current session and audits it in one statement (see lms.auth_logout). */
    async logout(ctx: RequestContext): Promise<void> {
      await sessionsService.logout(ctx);
    },

    /** Built from the session lookup row and the resolved tenant: no database access at all. */
    me(ctx: RequestContext, tenant: { id: string; slug: string } | null): MeResponse {
      return meResponse({
        user: { id: ctx.userId, email: ctx.email, displayName: ctx.displayName },
        tenant,
        role: ctx.role,
        isPlatformAdmin: ctx.isPlatformAdmin,
      });
    },

    /**
     * Always succeeds from the caller's point of view (202): whether the email exists is never
     * revealed. The email is queued in the background so the response time is the same either way;
     * the worker mints the single-use token when it sends (the outbox never holds a token).
     */
    async requestPasswordReset(input: {
      email: string;
      scope: HostScope;
      client: ClientInfo;
    }): Promise<void> {
      const email = normalizeEmail(input.email);
      const record = await db.withoutTenant((exec) => authRepo.findLogin(exec, email));
      if (!record) return;
      background.run(async () => {
        // the queued email and the audit row are ONE statement (a lost connection cannot leave one without the other)
        await db.withoutTenant((exec) =>
          authRepo.passwordResetRequested(exec, {
            userId: record.userId,
            tenantId: input.scope.tenant?.id ?? null,
            key: `reset:${newId()}`,
            auditId: newId(),
            ip: input.client.ip ?? null,
          }),
        );
      });
    },

    /**
     * The worker's half of a reset email: a fresh single-use token (30 minutes) for the user. Called
     * only by the email.send handler, right before it hands the message to the provider.
     */
    async mintResetToken(userId: string): Promise<{ token: string; minutes: number }> {
      const token = await generateToken();
      await db.withoutTenant((exec) =>
        authRepo.createToken(exec, {
          id: newId(),
          purpose: 'password_reset',
          tokenHash: hashToken(token),
          userId,
          tenantId: null,
          membershipId: null,
          ttlSeconds: config.resetTtlSeconds,
          createdBy: null,
        }),
      );
      return { token, minutes: Math.round(config.resetTtlSeconds / 60) };
    },

    /** The worker's half of the two-factor enrolment mail: a fresh single-use token (a newer one voids the older). */
    async mintMfaEnrolToken(
      userId: string,
      tenantId: string | null,
    ): Promise<{ token: string; minutes: number }> {
      const token = await generateToken();
      await db.withoutTenant((exec) =>
        authRepo.createToken(exec, {
          id: newId(),
          purpose: 'mfa_enrol',
          tokenHash: hashToken(token),
          userId,
          tenantId,
          membershipId: null,
          ttlSeconds: MFA_ENROL_LINK_TTL_SECONDS,
          createdBy: null,
        }),
      );
      return { token, minutes: Math.round(MFA_ENROL_LINK_TTL_SECONDS / 60) };
    },

    /**
     * The worker's half of an invite email: a fresh token for a membership that is STILL pending
     * (it voids the previous unused one). null = no longer pending: the email is skipped.
     */
    async mintInviteToken(
      tenantId: string,
      membershipId: string,
    ): Promise<{ token: string; days: number } | null> {
      const target = await db.withTenant(tenantId, (tx) =>
        authRepo.inviteTarget(tx, tenantId, membershipId),
      );
      if (target?.status !== 'pending') return null;
      const token = await generateToken();
      await db.withoutTenant((exec) =>
        authRepo.createToken(exec, {
          id: newId(),
          purpose: 'invite',
          tokenHash: hashToken(token),
          userId: target.userId,
          tenantId,
          membershipId,
          ttlSeconds: config.inviteTtlSeconds,
          createdBy: null,
        }),
      );
      return { token, days: Math.round(config.inviteTtlSeconds / 86400) };
    },

    /**
     * Redeems a reset token in ONE statement: sets the password, clears any lock, revokes every
     * session of the user and audits, atomically (see lms.auth_reset_password).
     */
    async resetPassword(input: {
      token: string;
      newPassword: string;
      scope: HostScope;
      client: ClientInfo;
    }): Promise<void> {
      assertPasswordAllowed(input.newPassword);
      const newHash = await hasher.hash(input.newPassword);
      const userId = await db.withoutTenant((exec) =>
        authRepo.resetPassword(exec, {
          tokenHash: hashToken(input.token),
          passwordHash: newHash,
          tenantId: input.scope.tenant?.id ?? null,
          ip: input.client.ip,
          auditId: newId(),
        }),
      );
      if (!userId) throw new InvalidTokenError();
    },

    /**
     * Change password (needs the current one): verify, then ONE statement sets the new password,
     * revokes every OTHER session of the user and audits.
     */
    /**
     * Password re-entry for a sensitive action (the data export, later the erasure): the signed-in person proves they hold the password,
     * not just a session. A wrong password is COUNTED like a failed sign-in (it feeds the same lockout, so a stolen session cannot
     * be used to guess the password through this door) and answers 400 `invalid_current_password`; while the account is locked the
     * password is not even checked.
     */
    async confirmPassword(ctx: RequestContext, password: string): Promise<void> {
      const record = await db.withoutTenant((exec) =>
        authRepo.findLogin(exec, normalizeEmail(ctx.email)),
      );
      const locked = !!record?.lockedUntil && record.lockedUntil.getTime() > Date.now();
      const ok =
        record && !locked
          ? await hasher.verify(record.passwordHash, password)
          : await hasher.verifyDummy(password);
      if (record && !locked && ok) return;
      if (record && !locked) {
        await db.withoutTenant((exec) =>
          authRepo.loginFailed(exec, {
            userId: record.userId,
            tenantId: ctx.tenantId ?? null,
            countAttempt: true,
            reason: 'bad_password_reauth',
            maxAttempts: config.maxAttempts,
            baseSeconds: config.lockBaseSeconds,
            maxSeconds: config.lockMaxSeconds,
            ip: ctx.ip ?? null,
            auditId: newId(),
            lockAuditId: newId(),
          }),
        );
      }
      throw new InvalidCurrentPasswordError();
    },

    async changePassword(
      ctx: RequestContext,
      input: { currentPassword: string; newPassword: string },
    ): Promise<void> {
      assertPasswordAllowed(input.newPassword);
      const record = await db.withoutTenant((exec) =>
        authRepo.findLogin(exec, normalizeEmail(ctx.email)),
      );
      const ok = record
        ? await hasher.verify(record.passwordHash, input.currentPassword)
        : await hasher.verifyDummy(input.currentPassword);
      if (!record || !ok) throw new InvalidCurrentPasswordError();
      const newHash = await hasher.hash(input.newPassword);
      await db.withoutTenant((exec) =>
        authRepo.changePassword(exec, {
          userId: ctx.userId,
          passwordHash: newHash,
          exceptSessionId: ctx.sessionId,
          tenantId: ctx.tenantId,
          ip: ctx.ip,
          auditId: newId(),
        }),
      );
    },

    /**
     * Institution admin invites someone by email: creates the user if needed, a PENDING membership
     * and a single-use token (7 days). The response never says whether the user already existed.
     */
    async createInvite(
      ctx: RequestContext,
      input: { email: string; role: string; displayName?: string | undefined; scope: HostScope },
    ): Promise<void> {
      if (!ctx.tenantId || !can(ctx, 'member.invite')) throw new ForbiddenError();
      if (!isMembershipRole(input.role)) {
        throw new BadRequestError(
          'invalid_membership_role',
          "Role must be 'institution_admin' or 'member'",
        );
      }
      const email = assertValidEmail(input.email);
      const { userId } = await usersService.ensureUser(
        email,
        input.displayName?.trim() || email.split('@')[0] || email,
      );
      const tenantId = ctx.tenantId;
      // The membership and its audit row are ONE transaction (found by the Postgres-restart test: a connection lost between two
      // transactions left a pending member with no audit row and no email). The audit row queues the invite email in that same
      // transaction (trigger audit_log_notify); the worker mints the token when it sends.
      await membershipsService.invite(tenantId, { userId, role: input.role }, (tx, membership) =>
        auditService.recordIn(tx, tenantId, {
          actorUserId: ctx.userId,
          action: 'auth.invite_created',
          targetType: 'membership',
          targetId: membership.id,
          metadata: { role: input.role, ...(ctx.ip ? { ip: ctx.ip } : {}) },
        }),
      );
    },

    /**
     * POST /members/:userId/resend-invite: a new invite email for a member who has not accepted yet.
     * The previous invite token stops working (auth_create_token voids it). Pending members only.
     */
    async resendInvite(ctx: RequestContext, userId: string, _scope: HostScope): Promise<void> {
      if (!ctx.tenantId || !can(ctx, 'member.invite')) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const r = await db.withTenant(tenantId, (tx) =>
        authRepo.resendInvite(tx, {
          tenantId,
          userId,
          actorUserId: ctx.userId,
          auditId: newId(),
        }),
      );
      if (!r) throw new MemberNotFoundError();
      if (!r.issued) throw new MemberNotPendingError();
    },

    /**
     * The `invites.send` job: queues the invite email for a membership created by a bulk import (the
     * import staggers these jobs to INVITE_RATE_PER_SECOND). Skipped when the member is no longer
     * pending (accepted, suspended or removed since): the outbox function checks that too.
     */
    async sendQueuedInvite(
      tenantId: string,
      input: { membershipId: string; userId?: string },
    ): Promise<{ sent: number; skipped: number }> {
      const target = input.userId
        ? { userId: input.userId, status: 'pending' }
        : await db.withTenant(tenantId, (tx) =>
            authRepo.inviteTarget(tx, tenantId, input.membershipId),
          );
      if (target?.status !== 'pending') return { sent: 0, skipped: 1 };
      const queued = await securityMail.enqueue({
        tenantId,
        userId: target.userId,
        template: 'invite',
        params: { membershipId: input.membershipId },
        key: `invite:import:${input.membershipId}`,
      });
      return queued ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
    },

    /** Public: redeems an invite token on the tenant it was issued for, activating the membership. */
    async acceptInvite(input: {
      token: string;
      password?: string | undefined;
      tenantId: string;
      client: ClientInfo;
    }): Promise<void> {
      let passwordHash: string | null = null;
      if (input.password !== undefined) {
        assertPasswordAllowed(input.password);
        passwordHash = await hasher.hash(input.password);
      }
      const result = await db.withoutTenant((exec) =>
        authRepo.acceptInvite(exec, {
          tokenHash: hashToken(input.token),
          expectedTenantId: input.tenantId,
          passwordHash,
          auditId: newId(),
          ip: input.client.ip ?? null,
        }),
      );
      if (result.status === 'password_required') throw new PasswordRequiredError();
      if (result.status !== 'ok' || !result.userId) throw new InvalidTokenError();
    },

    /**
     * Clears a lock on demand. An institution admin may unlock a member of their tenant; a platform
     * admin may unlock anyone from the admin host. Audited either way.
     */
    async unlockMember(ctx: RequestContext, targetUserId: string): Promise<void> {
      if (ctx.tenantId) {
        if (!can(ctx, 'member.unlock')) throw new ForbiddenError();
        const membership = await membershipsService.getMembership(ctx.tenantId, targetUserId);
        if (!membership) throw new NotFoundError('member_not_found', 'Member not found');
      } else if (!can(ctx, 'platform.user.unlock')) {
        throw new ForbiddenError();
      }
      // the unlock and its audit row are ONE statement
      await db.withoutTenant((exec) =>
        authRepo.unlockUser(exec, {
          userId: targetUserId,
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          auditId: newId(),
          ip: ctx.ip ?? null,
        }),
      );
    },

    /**
     * Deletes used/expired invite and reset tokens older than the retention period, in bounded
     * batches (the database function deletes at most `batchSize` rows per call).
     */
    async purgeTokens(opts: {
      retentionDays: number;
      batchSize: number;
      maxBatches?: number;
    }): Promise<number> {
      let total = 0;
      for (let i = 0; i < (opts.maxBatches ?? 100); i++) {
        const n = await db.withoutTenant((exec) =>
          authRepo.purgeTokens(exec, opts.retentionDays, opts.batchSize),
        );
        total += n;
        if (n < opts.batchSize) break;
      }
      return total;
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;

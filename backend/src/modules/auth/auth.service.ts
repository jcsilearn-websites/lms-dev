import { isMembershipRole, type MeResponse } from '../../contracts';
import { ALL_PERMISSIONS, can } from '../../core/authz';
import type { ClientInfo, RequestContext } from '../../core/context';
import { assertValidEmail, normalizeEmail } from '../../core/email';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors';
import { inviteEmail } from '../../core/invite-email';
import type { BackgroundTasks, Mailer } from '../../core/mailer';
import type { PasswordHasher } from '../../core/password';
import { generateToken, hashToken } from '../../core/tokens';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import type { AuditEntryInput, AuditService } from '../audit';
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

export interface LoginResult {
  token: string;
  expiresAt: Date;
  me: MeResponse;
}

export function createAuthService(deps: {
  db: Pick<Database, 'withoutTenant' | 'withTenant'>;
  authRepo: AuthRepository;
  hasher: PasswordHasher;
  mailer: Mailer;
  background: BackgroundTasks;
  sessionsService: Pick<SessionsService, 'completeLogin' | 'logout'>;
  usersService: Pick<UsersService, 'ensureUser'>;
  membershipsService: Pick<MembershipsService, 'getMembership' | 'invite'>;
  auditService: Pick<AuditService, 'record' | 'recordPlatform'>;
  config?: Partial<AuthConfig>;
  /** The origin of a college (scheme + slug + base domain [+ port]) for links in queued emails. */
  tenantOrigin?: (slug: string) => string;
}) {
  const { db, authRepo, hasher, mailer, background, sessionsService, usersService } = deps;
  const { membershipsService, auditService } = deps;
  const config: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...deps.config };

  /** Audit into the tenant's audit_log, or into platform_audit_log on the admin host. */
  function audit(
    tenantId: string | null,
    entry: AuditEntryInput,
    client?: ClientInfo | null,
  ): Promise<void> {
    const metadata = { ...(entry.metadata ?? {}), ...(client?.ip ? { ip: client.ip } : {}) };
    return tenantId
      ? auditService.record(tenantId, { ...entry, metadata })
      : auditService.recordPlatform({ ...entry, metadata, ip: client?.ip ?? null });
  }

  function meResponse(args: {
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

  return {
    /**
     * Email + password login on a tenant host (requires an ACTIVE membership) or on the admin host
     * (requires is_platform_admin). Two database statements on success: `auth_login_begin` (tenant
     * status, account, credentials, membership) and, after the argon2 check, `auth_login_complete`
     * (clear failures, create session, audit). Every failure is the same InvalidCredentialsError and
     * a verification always runs (a dummy hash for unknown emails); failure bookkeeping is one
     * deferred statement, so response time does not reveal whether the account exists.
     */
    async login(input: {
      email: string;
      password: string;
      tenant: { id: string; slug: string } | null;
      client: ClientInfo;
    }): Promise<LoginResult> {
      const email = normalizeEmail(input.email);
      const tenantId = input.tenant?.id ?? null;
      const begin = await db.withoutTenant((exec) => authRepo.loginBegin(exec, email, tenantId));

      // the plugin's slug cache may be up to a minute stale: the database says what is true now
      if (input.tenant && begin.tenantActive !== true) {
        throw new NotFoundError('tenant_not_found', 'Tenant not found');
      }

      const known = begin.userId !== null && begin.passwordHash !== null;
      const passwordOk = known
        ? await hasher.verify(begin.passwordHash as string, input.password)
        : await hasher.verifyDummy(input.password);
      const locked = !!begin.lockedUntil && begin.lockedUntil.getTime() > Date.now();
      const allowedHere = input.tenant
        ? begin.membershipStatus === 'active'
        : begin.isPlatformAdmin;

      if (!known || !passwordOk || locked || !allowedHere) {
        if (known && !locked) {
          const userId = begin.userId as string;
          const wrongPassword = !passwordOk;
          background.run(async () => {
            // only wrong passwords count towards the lockout; attempts while locked are ignored
            await db.withoutTenant((exec) =>
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
          });
        }
        throw new InvalidCredentialsError();
      }

      const userId = begin.userId as string;
      // transparent rehash when the stored hash uses older parameters (rare: its own statement)
      if (hasher.needsRehash(begin.passwordHash as string)) {
        const newHash = await hasher.hash(input.password);
        await db.withoutTenant((exec) => authRepo.setPassword(exec, userId, newHash));
      }

      const session = await sessionsService.completeLogin({
        userId,
        tenantId,
        ip: input.client.ip,
        userAgent: input.client.userAgent,
      });
      if (!session) throw new InvalidCredentialsError(); // membership/tenant changed in the meantime

      return {
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
     * revealed. The token is created and the mail sent in the background so the response time is
     * the same either way.
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
        const token = await generateToken();
        await db.withoutTenant((exec) =>
          authRepo.createToken(exec, {
            id: newId(),
            purpose: 'password_reset',
            tokenHash: hashToken(token),
            userId: record.userId,
            tenantId: null,
            membershipId: null,
            ttlSeconds: config.resetTtlSeconds,
            createdBy: null,
          }),
        );
        await mailer.send({
          to: email,
          subject: 'Reset your password',
          text: `Use this link within 30 minutes to choose a new password:\n${input.scope.origin}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this email.`,
        });
        await audit(
          input.scope.tenant?.id ?? null,
          {
            actorUserId: record.userId,
            action: 'auth.password_reset_requested',
            targetType: 'user',
            targetId: record.userId,
          },
          input.client,
        );
      });
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
      const membership = await membershipsService.invite(ctx.tenantId, {
        userId,
        role: input.role,
      });
      const token = await generateToken();
      await db.withoutTenant((exec) =>
        authRepo.createToken(exec, {
          id: newId(),
          purpose: 'invite',
          tokenHash: hashToken(token),
          userId,
          tenantId: ctx.tenantId,
          membershipId: membership.id,
          ttlSeconds: config.inviteTtlSeconds,
          createdBy: ctx.userId,
        }),
      );
      await mailer.send({
        to: email,
        ...inviteEmail({
          origin: input.scope.origin,
          token,
          days: Math.round(config.inviteTtlSeconds / 86400),
        }),
      });
      await audit(
        ctx.tenantId,
        {
          actorUserId: ctx.userId,
          action: 'auth.invite_created',
          targetType: 'membership',
          targetId: membership.id,
          metadata: { role: input.role },
        },
        ctx,
      );
    },

    /**
     * POST /members/:userId/resend-invite: a new invite email for a member who has not accepted yet.
     * The previous invite token stops working (auth_create_token voids it). Pending members only.
     */
    async resendInvite(ctx: RequestContext, userId: string, scope: HostScope): Promise<void> {
      if (!ctx.tenantId || !can(ctx, 'member.invite')) throw new ForbiddenError();
      const tenantId = ctx.tenantId;
      const token = await generateToken();
      const r = await db.withTenant(tenantId, (tx) =>
        authRepo.resendInvite(tx, {
          tenantId,
          userId,
          tokenId: newId(),
          tokenHash: hashToken(token),
          ttlSeconds: config.inviteTtlSeconds,
          actorUserId: ctx.userId,
          auditId: newId(),
        }),
      );
      if (!r) throw new MemberNotFoundError();
      if (!r.issued) throw new MemberNotPendingError();
      await mailer.send({
        to: r.email,
        ...inviteEmail({
          origin: scope.origin,
          token,
          days: Math.round(config.inviteTtlSeconds / 86400),
        }),
      });
    },

    /**
     * The `invites.send` job: emails the invite for a membership created by a bulk import. Runs on the
     * queue (never inside the import transaction), at the bounded rate the import staggered the jobs to.
     * Skipped when the member is no longer pending (accepted, suspended or removed since).
     */
    async sendQueuedInvite(
      tenantId: string,
      input: { membershipId: string },
    ): Promise<{ sent: number; skipped: number }> {
      const target = await db.withTenant(tenantId, (tx) =>
        authRepo.inviteTarget(tx, tenantId, input.membershipId),
      );
      if (target?.status !== 'pending' || !deps.tenantOrigin) {
        return { sent: 0, skipped: 1 };
      }
      const token = await generateToken();
      await db.withoutTenant((exec) =>
        authRepo.createToken(exec, {
          id: newId(),
          purpose: 'invite',
          tokenHash: hashToken(token),
          userId: target.userId,
          tenantId,
          membershipId: input.membershipId,
          ttlSeconds: config.inviteTtlSeconds,
          createdBy: null,
        }),
      );
      await mailer.send({
        to: target.email,
        ...inviteEmail({
          origin: deps.tenantOrigin(target.slug),
          token,
          days: Math.round(config.inviteTtlSeconds / 86400),
        }),
      });
      return { sent: 1, skipped: 0 };
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
        }),
      );
      if (result.status === 'password_required') throw new PasswordRequiredError();
      if (result.status !== 'ok' || !result.userId) throw new InvalidTokenError();
      await audit(
        input.tenantId,
        {
          actorUserId: result.userId,
          action: 'auth.invite_accepted',
          targetType: 'user',
          targetId: result.userId,
        },
        input.client,
      );
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
      await db.withoutTenant((exec) => authRepo.clearFailures(exec, targetUserId));
      await audit(
        ctx.tenantId,
        {
          actorUserId: ctx.userId,
          action: 'auth.account_unlocked',
          targetType: 'user',
          targetId: targetUserId,
        },
        ctx,
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

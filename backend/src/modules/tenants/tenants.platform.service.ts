import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { assertValidEmail } from '../../core/email';
import { ForbiddenError } from '../../core/errors';
import { buildOrigin } from '../../core/host';
import { inviteEmail } from '../../core/invite-email';
import type { Mailer } from '../../core/mailer';
import { buildPage, normalizePage, type Page } from '../../core/pagination';
import { prefixPattern } from '../../core/search';
import { generateToken, hashToken } from '../../core/tokens';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  pgConstraint,
  pgErrorCode,
} from '../../db/pg-errors';
import type { AuditService } from '../audit';
import type { ListMembersInput, Member, MembershipsService } from '../memberships';
import {
  AlreadyInstitutionAdminError,
  InvalidSlugError,
  InviteeSuspendedError,
  ReservedSlugError,
  SlugTakenError,
  TenantNotFoundError,
} from './tenants.errors';
import type {
  PlatformTenantDetailRow,
  PlatformTenantRow,
  TenantsPlatformRepository,
} from './tenants.platform.repository';

export type PlatformTenant = PlatformTenantRow;
export type PlatformTenantDetail = PlatformTenantDetailRow;

export interface PlatformConfig {
  baseDomain: string;
  /** https links (production) or http (local development) */
  secure: boolean;
  inviteTtlSeconds: number;
}

/** Where the admin host is served from: the invite link keeps its port in development. */
export interface AdminScope {
  portSuffix: string;
}

export type AdminInviteOutcome = 'invited' | 'promoted';

export interface AdminInviteResult {
  outcome: AdminInviteOutcome;
  userId: string;
  membershipId: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function createTenantsPlatformService(deps: {
  db: Pick<Database, 'withoutTenant'>;
  platformRepo: TenantsPlatformRepository;
  auditService: Pick<AuditService, 'withPlatformAdminAccess'>;
  membershipsService: Pick<MembershipsService, 'listPageIn'>;
  mailer: Mailer;
  config: PlatformConfig;
  /** Drops the slug cache (a created / suspended tenant must be visible at once on this instance). */
  clearSlugCache: () => void;
}) {
  const { db, platformRepo, auditService, membershipsService, mailer, config } = deps;

  /** Admin host only (tenantId is null) and the named platform permission. */
  function assertPlatform(
    ctx: RequestContext,
    permission: 'platform.tenant.read' | 'platform.tenant.manage',
  ): void {
    if (ctx.tenantId !== null || !can(ctx, permission)) throw new ForbiddenError();
  }

  async function sendInvite(email: string, slug: string, token: string, scope: AdminScope) {
    const origin = buildOrigin(
      { kind: 'tenant', slug, portSuffix: scope.portSuffix },
      config.baseDomain,
      config.secure,
    );
    await mailer.send({
      to: email,
      ...inviteEmail({
        origin: origin ?? '',
        token,
        days: Math.round(config.inviteTtlSeconds / 86400),
      }),
    });
  }

  return {
    /** GET /platform/tenants */
    async list(
      ctx: RequestContext,
      input: { q?: string | undefined; limit?: number | undefined; after?: string | undefined },
    ): Promise<Page<PlatformTenantRow>> {
      assertPlatform(ctx, 'platform.tenant.read');
      const { limit, after } = normalizePage(input);
      const pattern = input.q === undefined ? null : prefixPattern(input.q);
      const rows = await db.withoutTenant((exec) =>
        platformRepo.list(exec, ctx.userId, { pattern, after: after ?? null, limit: limit + 1 }),
      );
      return buildPage(rows, limit);
    },

    /** GET /platform/tenants/:id */
    async get(ctx: RequestContext, id: string): Promise<PlatformTenantDetailRow> {
      assertPlatform(ctx, 'platform.tenant.read');
      const row = await db.withoutTenant((exec) => platformRepo.get(exec, ctx.userId, id));
      if (!row) throw new TenantNotFoundError();
      return row;
    },

    /**
     * POST /platform/tenants: the college and its first institution admin's (pending) invite in one
     * transaction. The slug is immutable; reserved words are refused by the table's CHECK.
     */
    async create(
      ctx: RequestContext,
      input: { name: string; slug: string; adminEmail: string; adminName: string },
      scope: AdminScope,
    ): Promise<{ tenant: PlatformTenantDetailRow; invite: AdminInviteResult }> {
      assertPlatform(ctx, 'platform.tenant.manage');
      const slug = input.slug.trim().toLowerCase();
      if (!SLUG.test(slug)) throw new InvalidSlugError();
      const email = assertValidEmail(input.adminEmail);
      const tenantId = newId();
      const token = await generateToken();
      let created: { userId: string; membershipId: string };
      try {
        created = await db.withoutTenant((exec) =>
          platformRepo.create(exec, {
            actorUserId: ctx.userId,
            tenantId,
            slug,
            name: input.name.trim(),
            invite: {
              newUserId: newId(),
              email,
              displayName: input.adminName.trim(),
              membershipId: newId(),
              tokenId: newId(),
              tokenHash: hashToken(token),
              ttlSeconds: config.inviteTtlSeconds,
              ip: ctx.ip,
            },
            auditId: newId(),
            inviteAuditId: newId(),
            ip: ctx.ip,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new SlugTakenError();
        if (pgErrorCode(err) === '23514') {
          throw pgConstraint(err) === 'tenants_slug_not_reserved'
            ? new ReservedSlugError()
            : new InvalidSlugError();
        }
        throw err;
      }
      deps.clearSlugCache();
      const tenant = await db.withoutTenant((exec) => platformRepo.get(exec, ctx.userId, tenantId));
      if (!tenant) throw new TenantNotFoundError();
      await sendInvite(email, slug, token, scope);
      return { tenant, invite: { outcome: 'invited', ...created } };
    },

    /** PATCH /platform/tenants/:id: the name only (the slug is immutable). */
    async update(
      ctx: RequestContext,
      id: string,
      input: { name: string },
    ): Promise<PlatformTenantRow> {
      assertPlatform(ctx, 'platform.tenant.manage');
      const row = await db.withoutTenant((exec) =>
        platformRepo.update(exec, {
          actorUserId: ctx.userId,
          id,
          name: input.name.trim(),
          auditId: newId(),
          ip: ctx.ip,
        }),
      );
      if (!row) throw new TenantNotFoundError();
      return row;
    },

    /** Suspend / reactivate. Sessions stop at once: auth_lookup_session checks the tenant status. */
    async setStatus(
      ctx: RequestContext,
      id: string,
      status: 'active' | 'suspended',
    ): Promise<PlatformTenantRow> {
      assertPlatform(ctx, 'platform.tenant.manage');
      const r = await db.withoutTenant((exec) =>
        platformRepo.setStatus(exec, {
          actorUserId: ctx.userId,
          id,
          status,
          auditId: newId(),
          ip: ctx.ip,
        }),
      );
      if (!r) throw new TenantNotFoundError();
      deps.clearSlugCache();
      return r.tenant;
    },

    /**
     * POST /platform/tenants/:id/admin-invite: invite a (new) institution admin when the first invite
     * expired or the college lost its admin. An ACTIVE member of that college is promoted instead.
     * Audited in both logs by the function.
     */
    async inviteAdmin(
      ctx: RequestContext,
      tenantId: string,
      input: { email: string; displayName: string },
      scope: AdminScope,
    ): Promise<AdminInviteResult> {
      assertPlatform(ctx, 'platform.tenant.manage');
      const email = assertValidEmail(input.email);
      const token = await generateToken();
      const r = await db.withoutTenant((exec) =>
        platformRepo.adminInvite(exec, {
          actorUserId: ctx.userId,
          tenantId,
          newUserId: newId(),
          email,
          displayName: input.displayName.trim(),
          membershipId: newId(),
          tokenId: newId(),
          tokenHash: hashToken(token),
          ttlSeconds: config.inviteTtlSeconds,
          auditId: newId(),
          ip: ctx.ip,
        }),
      );
      if (r.status === 'tenant_not_found') throw new TenantNotFoundError();
      if (r.status === 'already_admin') throw new AlreadyInstitutionAdminError();
      if (r.status === 'suspended') throw new InviteeSuspendedError();
      const userId = r.userId as string;
      const membershipId = r.membershipId as string;
      if (r.status === 'promoted') {
        // their privileges changed: the function already revoked their sessions in this college;
        // tell them (no link, no token: nothing to click)
        await mailer.send({
          to: email,
          subject: `You are now an institution admin of ${r.tenantName ?? 'your college'}`,
          text: `You are now an institution admin of ${r.tenantName ?? 'your college'}. For your security you have been signed out: sign in again to use the new access.`,
        });
        return { outcome: 'promoted', userId, membershipId };
      }
      const tenant = await db.withoutTenant((exec) => platformRepo.get(exec, ctx.userId, tenantId));
      if (!tenant) throw new TenantNotFoundError();
      await sendInvite(email, tenant.slug, token, scope);
      return { outcome: 'invited', userId, membershipId };
    },

    /**
     * GET /platform/tenants/:id/members: a READ-ONLY view of a college's members through the audited
     * platform-admin helper. Every call writes the tenant's audit_log AND platform_audit_log in the
     * same transaction as the read.
     */
    async members(
      ctx: RequestContext,
      tenantId: string,
      input: ListMembersInput,
    ): Promise<Page<Member>> {
      assertPlatform(ctx, 'platform.tenant.read');
      try {
        return await auditService.withPlatformAdminAccess(
          { userId: ctx.userId, isPlatformAdmin: ctx.isPlatformAdmin },
          tenantId,
          {
            action: 'platform.tenant_members_read',
            targetType: 'tenant',
            targetId: tenantId,
            metadata: { filters: { role: input.role, status: input.status, q: input.q } },
            ip: ctx.ip,
          },
          (tx) => membershipsService.listPageIn(tx, tenantId, input),
        );
      } catch (err) {
        // the audit row references the tenant: an unknown id fails the foreign key
        if (isForeignKeyViolation(err)) throw new TenantNotFoundError();
        throw err;
      }
    },
  };
}
export type TenantsPlatformService = ReturnType<typeof createTenantsPlatformService>;

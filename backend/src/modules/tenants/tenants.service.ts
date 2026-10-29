import type { TenantInfo, UpdateBrandingRequest } from '../../contracts';
import { HEX_COLOR_PATTERN } from '../../contracts';
import type { ResolvedTenant } from '../../core/auth-context';
import { can } from '../../core/authz';
import type { RequestContext } from '../../core/context';
import { BadRequestError, ForbiddenError } from '../../core/errors';
import { buildPage, normalizePage, type Page, type PageRequest } from '../../core/pagination';
import { newId } from '../../core/uuid';
import type { Database } from '../../db/client';
import { TenantNotFoundError, TenantSettingNotFoundError } from './tenants.errors';
import type { TenantsRepository } from './tenants.repository';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface TenantSetting {
  id: string;
  key: string;
  value: unknown;
  updatedByMembershipId: string | null;
  updatedAt: Date;
}

export const DEFAULT_PRIMARY_COLOR = '#2563eb';
const HEX = new RegExp(HEX_COLOR_PATTERN);

/** The stored `branding` setting is jsonb: never trust its shape, fall back to the defaults. */
function brandingOf(raw: unknown, name: string): { displayName: string; primaryColor: string } {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const displayName =
    typeof v.displayName === 'string' && v.displayName.trim() ? v.displayName.trim() : name;
  const primaryColor =
    typeof v.primaryColor === 'string' && HEX.test(v.primaryColor)
      ? v.primaryColor.toLowerCase()
      : DEFAULT_PRIMARY_COLOR;
  return { displayName, primaryColor };
}

export interface TenantCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export function createTenantsService(deps: {
  db: Pick<Database, 'withTenant' | 'withoutTenant'>;
  tenantsRepo: TenantsRepository;
  cache?: TenantCacheOptions;
  now?: () => number;
}) {
  const { db, tenantsRepo } = deps;
  const cacheOpts = deps.cache ?? { ttlMs: 60_000, maxEntries: 1000 };
  const now = deps.now ?? Date.now;

  // slug -> tenant (or null = unknown). Short TTL and bounded; concurrent lookups for one slug share
  // a single query. A status change (suspension) is picked up within the TTL; sessions are checked
  // against the tenant status in the database on every request, so they stop immediately.
  const cache = new Map<string, { value: ResolvedTenant | null; expiresAt: number }>();
  const inflight = new Map<string, Promise<ResolvedTenant | null>>();

  async function lookup(slug: string): Promise<ResolvedTenant | null> {
    const row = await db.withoutTenant((exec) => tenantsRepo.resolveBySlug(exec, slug));
    return row ?? null;
  }

  return {
    /** Tenant by subdomain slug, before any tenant context exists. Cached with a short TTL. */
    async resolveBySlug(slug: string): Promise<ResolvedTenant | null> {
      const hit = cache.get(slug);
      if (hit && hit.expiresAt > now()) return hit.value;
      const pending = inflight.get(slug);
      if (pending) return pending;
      const p = lookup(slug)
        .then((value) => {
          if (cacheOpts.ttlMs > 0) {
            if (cache.size >= cacheOpts.maxEntries) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(slug, { value, expiresAt: now() + cacheOpts.ttlMs });
          }
          return value;
        })
        .finally(() => inflight.delete(slug));
      inflight.set(slug, p);
      return p;
    },

    /** Drops cached slugs (after suspending/reactivating a tenant, and in tests). */
    clearCache(): void {
      cache.clear();
    },

    /** The tenant itself (RLS only lets a tenant see its own row). */
    async getTenant(tenantId: string): Promise<Tenant> {
      const tenant = await db.withTenant(tenantId, (tx) => tenantsRepo.findById(tx, tenantId));
      if (!tenant) throw new TenantNotFoundError();
      return tenant;
    },

    /** PUBLIC branding of a tenant: slug, display name, primary colour. Nothing else leaves here. */
    async getInfo(tenantId: string): Promise<TenantInfo> {
      const row = await db.withTenant(tenantId, (tx) => tenantsRepo.readInfo(tx, tenantId));
      if (!row) throw new TenantNotFoundError();
      return { slug: row.slug, ...brandingOf(row.branding, row.name) };
    },

    /** PATCH /tenant/branding. The service re-checks the permission (the route check is coarse). */
    async updateBranding(ctx: RequestContext, input: UpdateBrandingRequest): Promise<TenantInfo> {
      if (!ctx.tenantId || !can(ctx, 'tenant.manage', { tenantId: ctx.tenantId })) {
        throw new ForbiddenError();
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new BadRequestError('invalid_display_name', 'The display name must not be empty');
      }
      const tenantId = ctx.tenantId;
      const row = await db.withTenant(tenantId, (tx) =>
        tenantsRepo.upsertBranding(tx, {
          tenantId,
          actorUserId: ctx.userId,
          settingId: newId(),
          auditId: newId(),
          value: { displayName, primaryColor: input.primaryColor.toLowerCase() },
        }),
      );
      if (!row) throw new TenantNotFoundError();
      return { slug: row.slug, ...brandingOf(row.branding, displayName) };
    },

    async listSettings(tenantId: string, request?: PageRequest): Promise<Page<TenantSetting>> {
      const { limit, after } = normalizePage(request);
      const rows = await db.withTenant(tenantId, (tx) =>
        tenantsRepo.listSettings(tx, { limit: limit + 1, after }),
      );
      return buildPage(rows, limit);
    },

    async setSetting(
      tenantId: string,
      input: { key: string; value: unknown; updatedByMembershipId?: string | null },
    ): Promise<TenantSetting> {
      const row = await db.withTenant(tenantId, (tx) =>
        tenantsRepo.upsertSetting(tx, { id: newId(), tenantId, ...input }),
      );
      if (!row) throw new TenantSettingNotFoundError();
      return row;
    },

    async deleteSetting(tenantId: string, key: string): Promise<void> {
      const removed = await db.withTenant(tenantId, (tx) => tenantsRepo.deleteSetting(tx, key));
      if (!removed) throw new TenantSettingNotFoundError();
    },
  };
}
export type TenantsService = ReturnType<typeof createTenantsService>;

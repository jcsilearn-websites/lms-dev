import type { ResolvedTenant } from '../../core/auth-context';
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

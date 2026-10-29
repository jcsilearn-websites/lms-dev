import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { tenantSettings, tenants } from './tenants.model';

const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  createdAt: tenants.createdAt,
};
const settingColumns = {
  id: tenantSettings.id,
  key: tenantSettings.key,
  value: tenantSettings.value,
  updatedByMembershipId: tenantSettings.updatedByMembershipId,
  updatedAt: tenantSettings.updatedAt,
};

export interface ResolvedTenantRow {
  id: string;
  slug: string;
  status: string;
}

export interface SettingInput {
  id: string;
  tenantId: string;
  key: string;
  value: unknown;
  updatedByMembershipId?: string | null;
}

// SQL only. Every function receives the transaction from the service (RLS scopes it to a tenant).
export function createTenantsRepository() {
  return {
    /**
     * Pre-tenant lookup by slug through the SECURITY DEFINER function (returns id, slug, status only).
     * Runs on a no-tenant executor: RLS would hide every tenant row from a plain SELECT here.
     */
    async resolveBySlug(db: Executor, slug: string): Promise<ResolvedTenantRow | undefined> {
      const result = await db.execute(
        sql`select id, slug, status from lms.auth_resolve_tenant(${slug}::text)`,
      );
      return result.rows[0] as ResolvedTenantRow | undefined;
    },

    async findById(tx: Executor, id: string) {
      const [row] = await tx.select(tenantColumns).from(tenants).where(eq(tenants.id, id)).limit(1);
      return row;
    },

    /** Keyset page over id; `limit` is the number of rows to fetch (callers pass page size + 1). */
    listSettings(tx: Executor, page: { limit: number; after?: string | undefined }) {
      const query = tx.select(settingColumns).from(tenantSettings);
      return (page.after ? query.where(gt(tenantSettings.id, page.after)) : query)
        .orderBy(asc(tenantSettings.id))
        .limit(page.limit);
    },

    async upsertSetting(tx: Executor, input: SettingInput) {
      const updatedByMembershipId = input.updatedByMembershipId ?? null;
      const [row] = await tx
        .insert(tenantSettings)
        .values({ ...input, updatedByMembershipId })
        .onConflictDoUpdate({
          target: [tenantSettings.tenantId, tenantSettings.key],
          set: { value: input.value, updatedByMembershipId, updatedAt: new Date() },
        })
        .returning(settingColumns);
      return row;
    },

    async deleteSetting(tx: Executor, key: string) {
      const rows = await tx
        .delete(tenantSettings)
        .where(eq(tenantSettings.key, key))
        .returning({ id: tenantSettings.id });
      return rows.length > 0;
    },
  };
}
export type TenantsRepository = ReturnType<typeof createTenantsRepository>;

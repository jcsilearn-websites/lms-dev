import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
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

export interface InfoRow {
  slug: string;
  name: string;
  /** the `branding` setting as stored (untrusted shape: validated by the service) */
  branding: unknown;
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

    /** Slug, name and the `branding` setting of the tenant in one query (RLS: only its own rows). */
    async readInfo(tx: Executor, tenantId: string): Promise<InfoRow | undefined> {
      const result = await tx.execute(sql`
        SELECT t.slug, t.name, s.value AS branding
          FROM lms.tenants t
          LEFT JOIN lms.tenant_settings s ON s.tenant_id = t.id AND s.key = 'branding'
         WHERE t.id = ${tenantId}::uuid`);
      return result.rows[0] as InfoRow | undefined;
    },

    /**
     * ONE statement: remember the old value, upsert the `branding` setting, write the audit entry
     * (before/after). Returns the tenant slug and the stored value.
     */
    async upsertBranding(
      tx: Executor,
      o: {
        tenantId: string;
        actorUserId: string;
        settingId: string;
        auditId: string;
        value: { displayName: string; primaryColor: string };
      },
    ): Promise<{ slug: string; branding: unknown } | undefined> {
      const result = await tx.execute(sql`
        WITH old AS (
          SELECT value FROM lms.tenant_settings WHERE tenant_id = ${o.tenantId}::uuid AND key = 'branding'
        ), up AS (
          INSERT INTO lms.tenant_settings (id, tenant_id, key, value, updated_by_membership_id)
          VALUES (${o.settingId}::uuid, ${o.tenantId}::uuid, 'branding', ${JSON.stringify(o.value)}::jsonb,
                  (SELECT id FROM lms.tenant_memberships
                    WHERE tenant_id = ${o.tenantId}::uuid AND user_id = ${o.actorUserId}::uuid))
          ON CONFLICT (tenant_id, key) DO UPDATE
            SET value = EXCLUDED.value, updated_by_membership_id = EXCLUDED.updated_by_membership_id,
                updated_at = now()
          RETURNING value
        ), aud AS (
          ${auditInsertFrom(
            {
              id: o.auditId,
              tenantId: o.tenantId,
              actorUserId: o.actorUserId,
              action: 'tenant.branding_updated',
              targetType: 'tenant',
            },
            {
              from: sql`up`,
              targetId: sql`${o.tenantId}::uuid`,
              metadata: sql`jsonb_build_object('before', (SELECT value FROM old), 'after', up.value)`,
            },
          )}
        )
        SELECT t.slug, up.value AS branding FROM up, lms.tenants t WHERE t.id = ${o.tenantId}::uuid`);
      return result.rows[0] as { slug: string; branding: unknown } | undefined;
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

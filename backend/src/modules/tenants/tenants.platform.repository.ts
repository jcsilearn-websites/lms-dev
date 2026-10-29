import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';

// SQL only: admin-host tenant management. lms_app can see no tenant row without a tenant context, so
// every call goes through a hardened SECURITY DEFINER function (migration 0009) on a no-tenant
// executor (db.withoutTenant): ONE function call = ONE statement = ONE round trip. The functions
// re-check that the actor is a platform admin and write the audit entries in the same statement.

export interface PlatformTenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformTenantDetailRow extends PlatformTenantRow {
  members: number;
  activeAdmins: number;
}

export type AdminInviteStatus =
  | 'invited'
  | 'promoted'
  | 'already_admin'
  | 'suspended'
  | 'tenant_not_found';

export interface AdminInviteArgs {
  actorUserId: string;
  tenantId: string;
  newUserId: string;
  email: string;
  displayName: string;
  membershipId: string;
  tokenId: string;
  tokenHash: Buffer;
  ttlSeconds: number;
  auditId: string;
  ip: string | null;
}

export interface AdminInviteRow {
  status: AdminInviteStatus;
  userId: string | null;
  membershipId: string | null;
  tenantName: string | null;
}

const toDate = (v: Date | string): Date => new Date(v);

function toTenant(r: Record<string, unknown>): PlatformTenantRow {
  return {
    id: r.r_id as string,
    slug: r.r_slug as string,
    name: r.r_name as string,
    status: r.r_status as PlatformTenantRow['status'],
    createdAt: toDate(r.r_created_at as Date | string),
    updatedAt: toDate(r.r_updated_at as Date | string),
  };
}

export function createTenantsPlatformRepository() {
  return {
    /** Keyset over the tenant id; `pattern` is a LIKE prefix for name or slug (indexed). */
    async list(
      db: Executor,
      actorUserId: string,
      f: { pattern: string | null; after: string | null; limit: number },
    ): Promise<PlatformTenantRow[]> {
      const res = await db.execute(
        sql`select * from lms.platform_list_tenants(${actorUserId}::uuid, ${f.pattern}::text, ${f.after}::uuid, ${f.limit}::int)`,
      );
      return res.rows.map(toTenant);
    },

    async get(
      db: Executor,
      actorUserId: string,
      id: string,
    ): Promise<PlatformTenantDetailRow | null> {
      const res = await db.execute(
        sql`select * from lms.platform_get_tenant(${actorUserId}::uuid, ${id}::uuid)`,
      );
      const r = res.rows[0];
      return r
        ? { ...toTenant(r), members: Number(r.r_members), activeAdmins: Number(r.r_active_admins) }
        : null;
    },

    /** Tenant + pending first admin + invite token in one statement (one transaction). */
    async create(
      db: Executor,
      a: {
        actorUserId: string;
        tenantId: string;
        slug: string;
        name: string;
        invite: Omit<AdminInviteArgs, 'actorUserId' | 'tenantId' | 'auditId'>;
        auditId: string;
        inviteAuditId: string;
        ip: string | null;
      },
    ): Promise<{ userId: string; membershipId: string }> {
      const i = a.invite;
      const res = await db.execute(
        sql`select * from lms.platform_create_tenant(${a.actorUserId}::uuid, ${a.tenantId}::uuid, ${a.slug}::text, ${a.name}::text,
              ${i.newUserId}::uuid, ${i.email}::text, ${i.displayName}::text, ${i.membershipId}::uuid, ${i.tokenId}::uuid,
              ${i.tokenHash}::bytea, ${i.ttlSeconds}::int, ${a.auditId}::uuid, ${a.inviteAuditId}::uuid, ${a.ip}::inet)`,
      );
      const r = res.rows[0] as { r_user_id: string; r_membership_id: string };
      return { userId: r.r_user_id, membershipId: r.r_membership_id };
    },

    async update(
      db: Executor,
      a: { actorUserId: string; id: string; name: string; auditId: string; ip: string | null },
    ): Promise<PlatformTenantRow | null> {
      const res = await db.execute(
        sql`select * from lms.platform_update_tenant(${a.actorUserId}::uuid, ${a.id}::uuid, ${a.name}::text, ${a.auditId}::uuid, ${a.ip}::inet)`,
      );
      const r = res.rows[0];
      return r ? toTenant(r) : null;
    },

    async setStatus(
      db: Executor,
      a: {
        actorUserId: string;
        id: string;
        status: 'active' | 'suspended';
        auditId: string;
        ip: string | null;
      },
    ): Promise<{ tenant: PlatformTenantRow; changed: boolean } | null> {
      const res = await db.execute(
        sql`select * from lms.platform_set_tenant_status(${a.actorUserId}::uuid, ${a.id}::uuid, ${a.status}::text, ${a.auditId}::uuid, ${a.ip}::inet)`,
      );
      const r = res.rows[0];
      return r ? { tenant: toTenant(r), changed: r.r_changed as boolean } : null;
    },

    async adminInvite(db: Executor, a: AdminInviteArgs): Promise<AdminInviteRow> {
      const res = await db.execute(
        sql`select * from lms.platform_admin_invite(${a.actorUserId}::uuid, ${a.tenantId}::uuid, ${a.newUserId}::uuid, ${a.email}::text,
              ${a.displayName}::text, ${a.membershipId}::uuid, ${a.tokenId}::uuid, ${a.tokenHash}::bytea, ${a.ttlSeconds}::int,
              ${a.auditId}::uuid, ${a.ip}::inet)`,
      );
      const r = res.rows[0] as {
        r_status: AdminInviteStatus;
        r_user_id: string | null;
        r_membership_id: string | null;
        r_name: string | null;
      };
      return {
        status: r.r_status,
        userId: r.r_user_id,
        membershipId: r.r_membership_id,
        tenantName: r.r_name,
      };
    },
  };
}
export type TenantsPlatformRepository = ReturnType<typeof createTenantsPlatformRepository>;

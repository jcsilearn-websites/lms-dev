import { type SQL, sql } from 'drizzle-orm';
import type { MembershipRole } from '../../contracts';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import { tenantMemberships } from './memberships.model';

// SQL only. Every function receives the transaction from the service. Mutations are ONE statement
// (data-modifying CTEs): read-and-lock the row, update it, revoke sessions, write the audit entry.
// The last-admin rule is a DB trigger (migration 0008): it surfaces here as a check_violation.

export type MembershipStatus = 'active' | 'pending' | 'suspended' | 'removed';

/** Every status except `removed`: a removed member is history, not a member (lists hide them unless asked). */
export const LIVE_STATUSES: MembershipStatus[] = ['active', 'pending', 'suspended'];

export interface MembershipRow {
  id: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
}

/** A member as the management API shows it: the membership joined with the user. */
export interface MemberRow extends MembershipRow {
  email: string;
  displayName: string;
  /** from the member profile (null when there is none) */
  profileType: 'student' | 'faculty' | 'staff' | null;
  registerNumber: string | null;
  employeeId: string | null;
  departmentId: string | null;
  batchId: string | null;
  sectionId: string | null;
}

export interface MemberListFilter {
  /** rows to fetch (page size + 1) */
  limit: number;
  after?: string | undefined;
  role?: MembershipRole | undefined;
  status?: MembershipStatus | undefined;
  /** LIKE prefix pattern from core/search.ts */
  pattern?: string | undefined;
  /** profile filters (member_profiles, indexed (tenant_id, <column>, membership_id)) */
  profileType?: string | undefined;
  departmentId?: string | undefined;
  batchId?: string | undefined;
  sectionId?: string | undefined;
}

export interface MembershipInput {
  id: string;
  tenantId: string;
  userId: string;
  role: MembershipRole;
  status?: MembershipStatus;
}

export interface AuditStamp {
  id: string;
  actorUserId: string;
  action: string;
}

export interface ChangeArgs {
  tenantId: string;
  userId: string;
  /** new values; null/undefined = keep */
  set: { role?: MembershipRole; status?: MembershipStatus };
  /** the update applies only when the CURRENT status is one of these (null = any) */
  requireStatus?: MembershipStatus[];
  revokeSessions: boolean;
  audit: AuditStamp;
}

export interface ChangeResult {
  found: boolean;
  changed: boolean;
  member: MemberRow | null;
  /** role/status BEFORE the change */
  before: { role: MembershipRole; status: MembershipStatus } | null;
}

const drizzleColumns = {
  id: tenantMemberships.id,
  userId: tenantMemberships.userId,
  role: tenantMemberships.role,
  status: tenantMemberships.status,
  createdAt: tenantMemberships.createdAt,
};

const toDate = (v: Date | string): Date => new Date(v);

function toMember(r: Record<string, unknown>): MemberRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    email: r.email as string,
    displayName: r.display_name as string,
    role: r.role as MembershipRole,
    status: r.status as MembershipStatus,
    createdAt: toDate(r.created_at as Date | string),
    profileType: (r.profile_type as MemberRow['profileType']) ?? null,
    registerNumber: (r.register_number as string | null) ?? null,
    employeeId: (r.employee_id as string | null) ?? null,
    departmentId: (r.department_id as string | null) ?? null,
    batchId: (r.batch_id as string | null) ?? null,
    sectionId: (r.section_id as string | null) ?? null,
  };
}

// The member list joins the user and the member PROFILE (LEFT JOIN: a member without a profile is a row
// with null profile fields). The profile tables belong to the profiles module; this is a read-only join.
const MEMBER_COLUMNS = sql`m.id, m.user_id, u.email, u.display_name, m.role, m.status, m.created_at,
  p.profile_type, p.register_number, p.employee_id, p.department_id, p.batch_id, p.section_id`;
const MEMBER_FROM = sql`lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
  LEFT JOIN lms.member_profiles p ON p.tenant_id = m.tenant_id AND p.membership_id = m.id`;

export function createMembershipsRepository() {
  return {
    async findByUserId(tx: Executor, userId: string): Promise<MembershipRow | undefined> {
      const [row] = await tx
        .select(drizzleColumns)
        .from(tenantMemberships)
        .where(sql`${tenantMemberships.userId} = ${userId}`)
        .limit(1);
      return row;
    },

    /**
     * Keyset page over the membership id (UUIDv7 = creation order: rows inserted later sort after the
     * cursor, so a page walk never repeats or shifts a row). Indexes (all lead with tenant_id):
     * (tenant_id, id) unfiltered, (tenant_id, role, id), (tenant_id, status, id), and the prefix
     * indexes on search_name / search_email. One query, the user is joined (no N+1).
     */
    async list(tx: Executor, tenantId: string, f: MemberListFilter): Promise<MemberRow[]> {
      const where: SQL[] = [sql`m.tenant_id = ${tenantId}::uuid`];
      if (f.role !== undefined) where.push(sql`m.role = ${f.role}::lms.membership_role`);
      // removed members are hidden unless the filter asks for them
      where.push(
        f.status === undefined
          ? sql`m.status <> 'removed'`
          : sql`m.status = ${f.status}::lms.membership_status`,
      );
      if (f.after !== undefined) where.push(sql`m.id > ${f.after}::uuid`);
      if (f.profileType !== undefined)
        where.push(sql`p.profile_type = ${f.profileType}::lms.profile_type`);
      if (f.departmentId !== undefined) where.push(sql`p.department_id = ${f.departmentId}::uuid`);
      if (f.batchId !== undefined) where.push(sql`p.batch_id = ${f.batchId}::uuid`);
      if (f.sectionId !== undefined) where.push(sql`p.section_id = ${f.sectionId}::uuid`);
      if (f.pattern !== undefined) {
        where.push(
          sql`(m.search_name LIKE ${f.pattern}::text OR m.search_email LIKE ${f.pattern}::text)`,
        );
      }
      const res = await tx.execute(
        sql`SELECT ${MEMBER_COLUMNS}
              FROM ${MEMBER_FROM}
             WHERE ${sql.join(where, sql` AND `)}
             ORDER BY m.id LIMIT ${f.limit}`,
      );
      return res.rows.map(toMember);
    },

    async findMember(tx: Executor, tenantId: string, userId: string): Promise<MemberRow | null> {
      const res = await tx.execute(
        sql`SELECT ${MEMBER_COLUMNS}
              FROM ${MEMBER_FROM}
             WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid`,
      );
      const row = res.rows[0];
      return row ? toMember(row) : null;
    },

    async insert(tx: Executor, input: MembershipInput): Promise<MembershipRow | undefined> {
      const [row] = await tx.insert(tenantMemberships).values(input).returning(drizzleColumns);
      return row;
    },

    /** A REMOVED member invited again: the same membership comes back as pending (history stays attached). */
    async reinstate(tx: Executor, id: string, role: MembershipRole) {
      const [row] = await tx
        .update(tenantMemberships)
        .set({ role, status: 'pending', updatedAt: new Date() })
        .where(sql`${tenantMemberships.id} = ${id}`)
        .returning(drizzleColumns);
      return row;
    },

    async updateRole(tx: Executor, id: string, role: MembershipRole) {
      const [row] = await tx
        .update(tenantMemberships)
        .set({ role, updatedAt: new Date() })
        .where(sql`${tenantMemberships.id} = ${id}`)
        .returning(drizzleColumns);
      return row;
    },

    /**
     * Role / status change in ONE statement: lock + read the old row, update it, revoke the user's
     * sessions in this tenant (auth_revoke_user_sessions) and write the audit entry with before/after.
     */
    async change(tx: Executor, a: ChangeArgs): Promise<ChangeResult> {
      const role = a.set.role ?? null;
      const status = a.set.status ?? null;
      const allowed = a.requireStatus ? `{${a.requireStatus.join(',')}}` : null;
      const audit = auditInsertFrom(
        {
          id: a.audit.id,
          tenantId: a.tenantId,
          actorUserId: a.audit.actorUserId,
          action: a.audit.action,
          targetType: 'membership',
        },
        {
          from: sql`old JOIN upd ON upd.id = old.id`,
          targetId: sql`old.id::text`,
          metadata: sql`jsonb_build_object('userId', old.user_id,
            'before', jsonb_build_object('role', old.role, 'status', old.status),
            'after', jsonb_build_object('role', upd.role, 'status', upd.status))`,
        },
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT m.id, m.user_id, m.role, m.status, m.created_at FROM lms.tenant_memberships m
           WHERE m.tenant_id = ${a.tenantId}::uuid AND m.user_id = ${a.userId}::uuid FOR UPDATE
        ), upd AS (
          UPDATE lms.tenant_memberships m
             SET role = COALESCE(${role}::lms.membership_role, m.role),
                 status = COALESCE(${status}::lms.membership_status, m.status),
                 updated_at = now()
            FROM old
           WHERE m.id = old.id
             AND (${allowed}::text[] IS NULL OR old.status::text = ANY(${allowed}::text[]))
             AND (${role}::lms.membership_role IS NULL OR old.role <> ${role}::lms.membership_role)
          RETURNING m.id, m.role, m.status
        ), rev AS (
          SELECT lms.auth_revoke_user_sessions(${a.userId}::uuid, NULL, ${a.tenantId}::uuid) AS n
            FROM upd WHERE ${a.revokeSessions}::boolean
        ), aud AS (${audit})
        SELECT old.id, old.user_id, u.email, u.display_name,
               old.role AS old_role, old.status AS old_status,
               COALESCE(upd.role, old.role) AS role, COALESCE(upd.status, old.status) AS status,
               old.created_at, (upd.id IS NOT NULL) AS changed,
               (SELECT count(*) FROM rev) AS revoked
          FROM old JOIN lms.users u ON u.id = old.user_id LEFT JOIN upd ON upd.id = old.id`);
      const r = res.rows[0];
      if (!r) return { found: false, changed: false, member: null, before: null };
      return {
        found: true,
        changed: r.changed as boolean,
        member: toMember(r),
        before: { role: r.old_role as MembershipRole, status: r.old_status as MembershipStatus },
      };
    },
  };
}
export type MembershipsRepository = ReturnType<typeof createMembershipsRepository>;

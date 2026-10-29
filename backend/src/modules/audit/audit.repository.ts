import { type SQL, sql } from 'drizzle-orm';
import type { TimeCursor } from '../../core/pagination';
import type { Executor } from '../../db/client';
import { auditLog } from './audit.model';

/** A listed log row. `cursorAt` is created_at as exact UTC text (microseconds) for the page cursor. */
export interface AuditListRow {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  cursorAt: string;
}

export interface AuditListFilter {
  /** rows to fetch (page size + 1) */
  limit: number;
  after?: TimeCursor | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const CURSOR_AT = sql.raw(
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
);

export interface AuditRow {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface PlatformAuditRow {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

function toRow(r: Record<string, unknown>): AuditListRow {
  return {
    id: r.id as string,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    action: r.action as string,
    targetType: r.target_type as string,
    targetId: (r.target_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(r.created_at as Date | string),
    cursorAt: r.cursor_at as string,
  };
}

// Insert + select only: the table is append-only for the application role.
export function createAuditRepository() {
  return {
    /** Tenant-less events go through the SECURITY DEFINER function (lms_app has no table access). */
    async insertPlatform(db: Executor, row: PlatformAuditRow) {
      await db.execute(
        sql`select lms.auth_audit_platform(${row.id}::uuid, ${row.actorUserId}::uuid, ${row.action}::text, ${row.targetType}::text, ${row.targetId}::text, ${JSON.stringify(row.metadata)}::jsonb, ${row.ip}::inet)`,
      );
    },

    async insert(tx: Executor, row: AuditRow) {
      await tx.insert(auditLog).values(row);
    },

    /**
     * Tenant log, newest first, keyset on (created_at, id). Backed by audit_log_tenant_created_idx and
     * audit_log_tenant_action_idx (both lead with tenant_id). The tenant filter is explicit (and RLS
     * applies as well) so the planner can use the index.
     */
    async listTenant(tx: Executor, tenantId: string, f: AuditListFilter): Promise<AuditListRow[]> {
      const where: SQL[] = [sql`tenant_id = ${tenantId}::uuid`];
      if (f.action !== undefined) where.push(sql`action = ${f.action}::text`);
      if (f.from !== undefined) where.push(sql`created_at >= ${f.from}::timestamptz`);
      if (f.to !== undefined) where.push(sql`created_at < ${f.to}::timestamptz`);
      if (f.after) {
        where.push(
          sql`(created_at, id) < (${f.after.createdAt}::timestamptz, ${f.after.id}::uuid)`,
        );
      }
      const res = await tx.execute(
        sql`SELECT id, actor_user_id, action, target_type, target_id, metadata, created_at, ${CURSOR_AT} AS cursor_at
              FROM lms.audit_log WHERE ${sql.join(where, sql` AND `)}
             ORDER BY created_at DESC, id DESC LIMIT ${f.limit}`,
      );
      return res.rows.map(toRow);
    },

    /** Platform log (no tenant): lms_app has no table access, the definer function checks the actor. */
    async listPlatform(db: Executor, actorUserId: string, f: AuditListFilter) {
      const res = await db.execute(
        sql`SELECT r_id AS id, r_actor_user_id AS actor_user_id, r_action AS action,
                   r_target_type AS target_type, r_target_id AS target_id, r_metadata AS metadata,
                   r_created_at AS created_at, r_cursor_at AS cursor_at
              FROM lms.platform_list_audit(${actorUserId}::uuid, ${f.action ?? null}::text,
                   ${f.from ?? null}::timestamptz, ${f.to ?? null}::timestamptz,
                   ${f.after?.createdAt ?? null}::timestamptz, ${f.after?.id ?? null}::uuid, ${f.limit}::int)`,
      );
      return res.rows.map(toRow);
    },
  };
}
export type AuditRepository = ReturnType<typeof createAuditRepository>;

import { type SQL, sql } from 'drizzle-orm';

export interface AuditCteEntry {
  /** one id, or an SQL expression (e.g. lms.uuid_v7()) when the entry produces one row per source row */
  id: string | SQL;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
}

/**
 * `INSERT INTO lms.audit_log ... SELECT ... FROM <source>` as the body of a CTE, so another module's
 * repository can fold the audit entry into the SAME statement as the change it records (one round
 * trip; the entry exists exactly when the change does). The audit module owns the table, so the
 * column list lives here. `source.from` is a table expression whose rows carry the values
 * (before/after of the change); `targetId` and `metadata` are expressions over it.
 */
export function auditInsertFrom(
  entry: AuditCteEntry,
  source: { from: SQL; targetId: SQL; metadata: SQL },
): SQL {
  return sql`INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    SELECT ${typeof entry.id === 'string' ? sql`${entry.id}::uuid` : entry.id}, ${entry.tenantId}::uuid, ${entry.actorUserId}::uuid, ${entry.action}::text,
           ${entry.targetType}::text, ${source.targetId}, ${source.metadata}
      FROM ${source.from}`;
}

import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. One statement per function.
export type Row = Record<string, unknown>;

const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;

export function createFilesRepository() {
  return {
    /** Records a pending upload, only when the caller may edit the offering (decided in the same statement). */
    async createPending(
      tx: Executor,
      a: AccessSpec,
      f: { id: string; storageKey: string; name: string; contentType: string; size: number },
      createdBy: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        ins AS (
          INSERT INTO lms.files (id, tenant_id, storage_key, original_name, content_type, declared_size, created_by)
          SELECT ${f.id}::uuid, ${a.tenantId}::uuid, ${f.storageKey}, ${f.name}, ${f.contentType}, ${f.size}::bigint,
                 ${createdBy}::uuid
            FROM acc WHERE acc.visible AND acc.allowed AND acc.status <> 'archived'
          RETURNING id, original_name, content_type, declared_size AS size, status, created_at, storage_key
        )
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT to_jsonb(ins) FROM ins) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    /** A file the caller uploaded (the only one who may confirm it). */
    async findOwn(tx: Executor, tenantId: string, id: string, userId: string): Promise<Row | null> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(f) AS row FROM (
          SELECT id, original_name, content_type, coalesce(size_bytes, declared_size) AS size, declared_size,
                 status, created_at, storage_key
            FROM lms.files
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND created_by = ${userId}::uuid) f`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    /** pending -> ready with the measured values; no-op for a file that is already ready. */
    async markReady(
      tx: Executor,
      tenantId: string,
      id: string,
      v: { size: number; sha256: string; contentType: string },
    ): Promise<Row | null> {
      const res = await tx.execute(sql`
        WITH upd AS (
          UPDATE lms.files SET size_bytes = ${v.size}::bigint, sha256 = ${v.sha256}, content_type = ${v.contentType},
                 status = 'ready', confirmed_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'pending'
          RETURNING id, original_name, content_type, size_bytes AS size, status, created_at, storage_key)
        SELECT to_jsonb(upd) AS row FROM upd`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    /** Worker: deletes unreferenced files past their grace period and returns their storage keys. */
    async purge(tx: Executor, graceHours: number, limit: number): Promise<string[]> {
      const res = await tx.execute(sql`
        SELECT storage_key FROM lms.files_purge(make_interval(hours => ${graceHours}::int), ${limit}::int)`);
      return res.rows.map((r) => r.storage_key as string);
    },
  };
}
export type FilesRepository = ReturnType<typeof createFilesRepository>;

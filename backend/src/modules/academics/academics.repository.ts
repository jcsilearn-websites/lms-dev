import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import { type Entity, selectColumns } from './academics.entities';

// SQL only. One generic implementation drives all six entities (see academics.entities.ts). Rows come
// back as JSON objects with the snake_case column names (to_jsonb: dates as YYYY-MM-DD, timestamps as
// ISO-8601). Every change is ONE statement (data-modifying CTEs: lock + change + audit entry), so a
// request costs lookup + BEGIN + statement + COMMIT = 4 round trips. The invariants themselves (one
// current year, no overlapping terms, unique codes, immutable parents, archive refusals) are enforced by
// the database (migration 0011); this file only surfaces its errors.

export type Row = Record<string, unknown>;

export interface AuditStamp {
  id: string;
  actorUserId: string;
}

export interface ListFilter {
  limit: number;
  after?: string | undefined;
  archived: 'false' | 'true' | 'all';
  /** column -> value (equality) */
  equals: Record<string, string | number>;
  current?: boolean | undefined;
}

export interface Transition {
  found: boolean;
  changed: boolean;
  row: Row | null;
}

const raw = (s: string) => sql.raw(s);
const cols = (e: Entity, prefix = '') =>
  selectColumns(e)
    .map((c) => `${prefix}${c}`)
    .join(', ');

function auditStamp(
  e: Entity,
  tenantId: string,
  a: AuditStamp,
  verb: string,
  from: SQL,
  /** the CTE alias that carries the row's id (old / ins / upd) */
  idRef: string,
  metadata: SQL,
): SQL {
  return auditInsertFrom(
    {
      id: a.id,
      tenantId,
      actorUserId: a.actorUserId,
      action: `academic.${e.audit}.${verb}`,
      targetType: e.audit,
    },
    { from, targetId: raw(`${idRef}.id::text`), metadata },
  );
}

/** Reads the (changed, row) pair produced by the common final SELECT of the transitions. */
function toTransition(res: { rows: Row[] }): Transition {
  const r = res.rows[0];
  const row = (r?.row as Row | null | undefined) ?? null;
  return { found: row !== null, changed: r?.changed === true, row };
}

export function createAcademicsRepository() {
  return {
    /** Keyset page over the id; filters are equality on indexed columns (all lead with tenant_id). */
    async list(tx: Executor, e: Entity, tenantId: string, f: ListFilter): Promise<Row[]> {
      const where: SQL[] = [sql`tenant_id = ${tenantId}::uuid`];
      if (f.archived === 'false') where.push(sql`archived_at IS NULL`);
      if (f.archived === 'true') where.push(sql`archived_at IS NOT NULL`);
      for (const [column, value] of Object.entries(f.equals)) {
        where.push(sql`${raw(column)} = ${value}`);
      }
      if (f.current !== undefined) where.push(sql`is_current = ${f.current}::boolean`);
      if (f.after !== undefined) where.push(sql`id > ${f.after}::uuid`);
      const res = await tx.execute(
        sql`SELECT to_jsonb(r) AS row FROM (
              SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
               WHERE ${sql.join(where, sql` AND `)} ORDER BY id LIMIT ${f.limit}
            ) r ORDER BY r.id`,
      );
      return res.rows.map((r) => r.row as Row);
    },

    async get(tx: Executor, e: Entity, tenantId: string, id: string): Promise<Row | null> {
      const res = await tx.execute(
        sql`SELECT to_jsonb(r) AS row FROM (
              SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
               WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
            ) r`,
      );
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    async create(
      tx: Executor,
      e: Entity,
      tenantId: string,
      id: string,
      values: Record<string, unknown>,
      audit: AuditStamp,
    ): Promise<Row> {
      const columns = Object.keys(values);
      const aud = auditStamp(
        e,
        tenantId,
        audit,
        'created',
        raw('ins'),
        'ins',
        sql`jsonb_build_object('after', to_jsonb(ins))`,
      );
      const res = await tx.execute(sql`
        WITH ins AS (
          INSERT INTO ${raw(`lms.${e.table}`)} (id, tenant_id, ${raw(columns.join(', '))})
          VALUES (${id}::uuid, ${tenantId}::uuid, ${sql.join(
            columns.map((c) => sql`${values[c]}`),
            sql`, `,
          )})
          RETURNING ${raw(cols(e))}
        ), aud AS (${aud})
        SELECT to_jsonb(ins) AS row FROM ins`);
      return res.rows[0]?.row as Row;
    },

    async update(
      tx: Executor,
      e: Entity,
      tenantId: string,
      id: string,
      values: Record<string, unknown>,
      audit: AuditStamp,
    ): Promise<Row | null> {
      const set = sql.join(
        Object.entries(values).map(([c, v]) => sql`${raw(c)} = ${v}`),
        sql`, `,
      );
      const aud = auditStamp(
        e,
        tenantId,
        audit,
        'updated',
        raw('old JOIN upd ON upd.id = old.id'),
        'old',
        sql`jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(upd))`,
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), upd AS (
          UPDATE ${raw(`lms.${e.table}`)} x SET ${set}, updated_at = now() FROM old
           WHERE x.id = old.id RETURNING ${raw(cols(e, 'x.'))}
        ), aud AS (${aud})
        SELECT to_jsonb(upd) AS row FROM upd`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    /** archive (archived_at = now()) or unarchive (NULL): idempotent, reports whether it changed anything. */
    async setArchived(
      tx: Executor,
      e: Entity,
      tenantId: string,
      id: string,
      archive: boolean,
      audit: AuditStamp,
    ): Promise<Transition> {
      const aud = auditStamp(
        e,
        tenantId,
        audit,
        archive ? 'archived' : 'unarchived',
        raw('old JOIN upd ON upd.id = old.id'),
        'old',
        sql`jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(upd))`,
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), upd AS (
          UPDATE ${raw(`lms.${e.table}`)} x
             SET archived_at = ${archive ? sql`now()` : sql`NULL`}, updated_at = now()
            FROM old
           WHERE x.id = old.id AND (x.archived_at IS NULL) = ${archive}::boolean
          RETURNING ${raw(cols(e, 'x.'))}
        ), aud AS (${aud})
        SELECT COALESCE((SELECT to_jsonb(upd) FROM upd), (SELECT to_jsonb(old) FROM old)) AS row,
               EXISTS (SELECT 1 FROM upd) AS changed`);
      return toTransition(res as { rows: Row[] });
    },

    /** Hard delete: only possible while nothing references the row (ON DELETE RESTRICT). */
    async remove(
      tx: Executor,
      e: Entity,
      tenantId: string,
      id: string,
      audit: AuditStamp,
    ): Promise<boolean> {
      const aud = auditStamp(
        e,
        tenantId,
        audit,
        'deleted',
        raw('old JOIN del ON del.id = old.id'),
        'old',
        sql`jsonb_build_object('before', to_jsonb(old))`,
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), del AS (
          DELETE FROM ${raw(`lms.${e.table}`)} x USING old WHERE x.id = old.id RETURNING x.id
        ), aud AS (${aud})
        SELECT (SELECT count(*) FROM del)::int AS n`);
      return Number(res.rows[0]?.n ?? 0) > 0;
    },

    /** Makes `id` the tenant's one current academic year, in one UPDATE (the constraint is checked at its end). */
    async setCurrent(
      tx: Executor,
      e: Entity,
      tenantId: string,
      id: string,
      audit: AuditStamp,
    ): Promise<Transition> {
      const aud = auditStamp(
        e,
        tenantId,
        audit,
        'set_current',
        sql`upd WHERE upd.id = ${id}::uuid`,
        'upd',
        sql`jsonb_build_object('after', to_jsonb(upd))`,
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT ${raw(cols(e))} FROM ${raw(`lms.${e.table}`)}
           WHERE tenant_id = ${tenantId}::uuid AND (id = ${id}::uuid OR is_current) FOR UPDATE
        ), upd AS (
          UPDATE ${raw(`lms.${e.table}`)} x SET is_current = (x.id = ${id}::uuid), updated_at = now()
            FROM old WHERE x.id = old.id AND (x.id = ${id}::uuid) <> x.is_current
          RETURNING ${raw(cols(e, 'x.'))}
        ), aud AS (${aud})
        SELECT COALESCE((SELECT to_jsonb(upd) FROM upd WHERE upd.id = ${id}::uuid),
                        (SELECT to_jsonb(old) FROM old WHERE old.id = ${id}::uuid)) AS row,
               EXISTS (SELECT 1 FROM upd WHERE upd.id = ${id}::uuid) AS changed`);
      return toTransition(res as { rows: Row[] });
    },
  };
}
export type AcademicsRepository = ReturnType<typeof createAcademicsRepository>;

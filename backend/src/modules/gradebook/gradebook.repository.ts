import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. The calculation and every rule live in the database functions of migrations 0040 / 0041 (one source of truth:
// the grid, the learner's view, the explanation and the lock snapshot all call `lms.gradebook_compute`). A staff call is ONE
// statement: the offering access CTE and the function call travel together, so the decision and the work share a snapshot
// (4 round trips with the session lookup). The learner call is ONE definer function on an autocommit connection (2).
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const T = (a: AccessSpec) => sql`${a.tenantId}::uuid`;
const O = (a: AccessSpec) => sql`${a.offeringId}::uuid`;
const U = (a: AccessSpec) => sql`${a.userId}::uuid`;
const json = (v: unknown): SQL => sql`${JSON.stringify(v)}::jsonb`;

/** An instructor (or an administrator who may enter marks) may use every manual item; an assistant only the allowed ones. */
const ALL_ITEMS = sql`coalesce((SELECT acc.participation = 'instructor' FROM acc), false)`;

export interface Called {
  acc: AccessRow | null;
  res: Row | null;
}

async function call(tx: Executor, a: AccessSpec, fn: SQL): Promise<Called> {
  const r = await tx.execute(sql`
    WITH ${accessCte(a)}
    SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
           (SELECT ${fn} FROM acc WHERE acc.visible AND acc.allowed) AS res`);
  const row = r.rows[0] as { acc?: unknown; res?: unknown } | undefined;
  return { acc: asAcc(row?.acc), res: (row?.res as Row | null) ?? null };
}

export function createGradebookRepository() {
  return {
    config: (tx: Executor, a: AccessSpec) =>
      call(tx, a, sql`lms.gradebook_config(${T(a)}, ${O(a)})`),
    review: (tx: Executor, a: AccessSpec) =>
      call(tx, a, sql`lms.gradebook_review(${T(a)}, ${O(a)})`),

    updateSettings: (tx: Executor, a: AccessSpec, patch: Record<string, unknown>) =>
      call(tx, a, sql`lms.gradebook_settings_update(${T(a)}, ${U(a)}, ${O(a)}, ${json(patch)})`),
    saveCategories: (tx: Executor, a: AccessSpec, categories: unknown[]) =>
      call(
        tx,
        a,
        sql`lms.gradebook_categories_save(${T(a)}, ${U(a)}, ${O(a)}, ${json(categories)})`,
      ),
    saveItems: (tx: Executor, a: AccessSpec, items: unknown[]) =>
      call(tx, a, sql`lms.gradebook_items_save(${T(a)}, ${U(a)}, ${O(a)}, ${json(items)})`),

    grid: (
      tx: Executor,
      a: AccessSpec,
      q: { section: string | null; afterKey: string | null; afterId: string | null; limit: number },
    ) =>
      call(
        tx,
        a,
        sql`lms.gradebook_grid(${T(a)}, ${O(a)}, ${q.section}::uuid, ${q.afterKey}::text, ${q.afterId}::uuid, ${q.limit}::integer)`,
      ),
    explain: (tx: Executor, a: AccessSpec, participantId: string) =>
      call(tx, a, sql`lms.gradebook_explain(${T(a)}, ${O(a)}, ${participantId}::uuid)`),

    saveMarks: (tx: Executor, a: AccessSpec, cells: unknown[]) =>
      call(
        tx,
        a,
        sql`lms.gradebook_marks_save(${T(a)}, ${U(a)}, ${O(a)}, ${ALL_ITEMS}, 'grid', ${json(cells)})`,
      ),
    stageImport: (tx: Executor, a: AccessSpec, rows: number, cells: unknown[]) =>
      call(
        tx,
        a,
        sql`lms.gradebook_import_stage(${T(a)}, ${U(a)}, ${O(a)}, ${ALL_ITEMS}, ${rows}::integer, ${json(cells)})`,
      ),
    getImport: (tx: Executor, a: AccessSpec, importId: string) =>
      call(tx, a, sql`lms.gradebook_import_get(${T(a)}, ${O(a)}, ${importId}::uuid)`),
    applyImport: (tx: Executor, a: AccessSpec, importId: string, skipInvalid: boolean) =>
      call(
        tx,
        a,
        sql`lms.gradebook_import_apply(${T(a)}, ${U(a)}, ${O(a)}, ${ALL_ITEMS}, ${importId}::uuid, ${skipInvalid}::boolean)`,
      ),

    setOverride: (
      tx: Executor,
      a: AccessSpec,
      v: { participantId: string; itemId: string | null; points: string; reason: string },
    ) =>
      call(
        tx,
        a,
        sql`lms.gradebook_override_set(${T(a)}, ${U(a)}, ${O(a)}, ${v.participantId}::uuid, ${v.itemId}::uuid, ${v.points}::numeric, ${v.reason})`,
      ),
    revokeOverride: (tx: Executor, a: AccessSpec, participantId: string, itemId: string | null) =>
      call(
        tx,
        a,
        sql`lms.gradebook_override_revoke(${T(a)}, ${U(a)}, ${O(a)}, ${participantId}::uuid, ${itemId}::uuid)`,
      ),

    submit: (tx: Executor, a: AccessSpec) =>
      call(tx, a, sql`lms.gradebook_submit(${T(a)}, ${U(a)}, ${O(a)})`),
    reviewAction: (
      tx: Executor,
      a: AccessSpec,
      action: 'approve' | 'return',
      comment: string | null,
    ) =>
      call(
        tx,
        a,
        sql`lms.gradebook_review_action(${T(a)}, ${U(a)}, ${O(a)}, ${action}::text, ${comment}::text)`,
      ),
    unlock: (tx: Executor, a: AccessSpec, reason: string) =>
      call(tx, a, sql`lms.gradebook_unlock(${T(a)}, ${U(a)}, ${O(a)}, ${reason})`),

    snapshotMeta: (tx: Executor, a: AccessSpec, version: number | null) =>
      call(tx, a, sql`lms.gradebook_snapshot_meta(${T(a)}, ${O(a)}, ${version}::integer)`),
    /** a page of a snapshot (the access was decided by the call that read the meta) */
    async snapshotPage(
      tx: Executor,
      tenantId: string,
      versionId: string,
      after: { key: string; id: string } | null,
      limit: number,
      withExplanation: boolean,
    ): Promise<Row[]> {
      const r = await tx.execute(
        sql`SELECT lms.gradebook_snapshot_page(${tenantId}::uuid, ${versionId}::uuid, ${after?.key ?? null}::text,
                ${after?.id ?? null}::uuid, ${limit}::integer, ${withExplanation}::boolean) AS rows`,
      );
      return ((r.rows[0] as { rows?: unknown } | undefined)?.rows as Row[]) ?? [];
    },

    /** The approval queue of the college (no offering: an account permission decides). */
    async queue(
      tx: Executor,
      tenantId: string,
      q: { status: string; afterAt: string | null; afterId: string | null; limit: number },
    ): Promise<Row[]> {
      const r = await tx.execute(
        sql`SELECT lms.gradebook_queue(${tenantId}::uuid, ${q.status}::text, ${q.afterAt}::timestamptz,
                ${q.afterId}::uuid, ${q.limit}::integer) AS rows`,
      );
      return ((r.rows[0] as { rows?: unknown } | undefined)?.rows as Row[]) ?? [];
    },

    /** The learner's own grades: a definer function, autocommit, no tenant context needed. */
    async me(
      conn: Executor,
      v: { tenantId: string; userId: string; offeringId: string },
    ): Promise<Row> {
      const r = await conn.execute(
        sql`SELECT lms.gradebook_me(${v.tenantId}::uuid, ${v.userId}::uuid, ${v.offeringId}::uuid) AS res`,
      );
      return (
        ((r.rows[0] as { res?: unknown } | undefined)?.res as Row) ?? { result: 'no_offering' }
      );
    },

    // ------------------------------------------------------------ grade scales (tenant level)
    async listScales(tx: Executor, tenantId: string, includeArchived: boolean): Promise<Row[]> {
      const r = await tx.execute(
        sql`SELECT lms.grade_scales_list(${tenantId}::uuid, ${includeArchived}::boolean) AS rows`,
      );
      return ((r.rows[0] as { rows?: unknown } | undefined)?.rows as Row[]) ?? [];
    },
    async saveScale(tx: Executor, tenantId: string, userId: string, scale: unknown): Promise<Row> {
      const r = await tx.execute(
        sql`SELECT lms.grade_scale_save(${tenantId}::uuid, ${userId}::uuid, ${json(scale)}) AS res`,
      );
      return (r.rows[0] as { res: Row }).res;
    },
    async archiveScale(
      tx: Executor,
      tenantId: string,
      userId: string,
      scaleId: string,
      archived: boolean,
    ): Promise<Row> {
      const r = await tx.execute(
        sql`SELECT lms.grade_scale_archive(${tenantId}::uuid, ${userId}::uuid, ${scaleId}::uuid, ${archived}::boolean) AS res`,
      );
      return (r.rows[0] as { res: Row }).res;
    },

    // ------------------------------------------------------------ the college setting (tenant_settings key 'gradebook')
    async getSettings(tx: Executor, tenantId: string): Promise<{ allowSelfApproval: boolean }> {
      const r = await tx.execute(sql`SELECT lms.gb_self_approval(${tenantId}::uuid) AS v`);
      return { allowSelfApproval: (r.rows[0] as { v: boolean }).v === true };
    },
    /** One statement: upsert the setting and write the audit entry with before and after. */
    async setSettings(
      tx: Executor,
      tenantId: string,
      userId: string,
      allowSelfApproval: boolean,
    ): Promise<{ allowSelfApproval: boolean }> {
      const r = await tx.execute(sql`
        WITH old AS (SELECT lms.gb_self_approval(${tenantId}::uuid) AS v),
        up AS (
          INSERT INTO lms.tenant_settings (id, tenant_id, key, value)
          VALUES (lms.uuid_v7(), ${tenantId}::uuid, 'gradebook', jsonb_build_object('allowSelfApproval', ${allowSelfApproval}::boolean))
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          RETURNING value),
        au AS (SELECT lms.gb_audit(${tenantId}::uuid, ${userId}::uuid, 'gradebook.settings_changed', NULL,
                 jsonb_build_object('before', jsonb_build_object('allowSelfApproval', (SELECT v FROM old)),
                                    'after', jsonb_build_object('allowSelfApproval', ${allowSelfApproval}::boolean))) FROM up)
        SELECT (SELECT count(*) FROM au) AS n`);
      void r;
      return { allowSelfApproval };
    },

    async purgeImports(conn: Executor, hours: number): Promise<number> {
      const r = await conn.execute(
        sql`SELECT lms.gradebook_purge_imports(${hours}::integer, 1000) AS n`,
      );
      return Number((r.rows[0] as { n: number | string }).n);
    },
  };
}
export type GradebookRepository = ReturnType<typeof createGradebookRepository>;

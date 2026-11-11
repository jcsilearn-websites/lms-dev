import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. Every function sends ONE statement: the offering access check (CTE `acc`), the position pick and
// the change are fused, so a caller who may not do it changes nothing and a stale sibling is reported.
export type Row = Record<string, unknown>;

/** Where an entry goes among its siblings: undefined = the end, null = first, an id = right after it. */
export type After = string | null | undefined;

const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const may = sql`acc.visible AND acc.allowed AND acc.status <> 'archived'`;

/** Staff (administrators, instructors, assistants) see everything; learners only published, opened entries. */
const staffOf = (a: AccessSpec): SQL =>
  sql`(${a.viewAll}::boolean OR (SELECT participation FROM acc) IN ('instructor', 'assistant'))`;

/**
 * `pos AS (SELECT <new position> AS p)` between the siblings selected by `scope` (alias `s`). `exclude` is the id
 * of the entry being moved (it is not its own sibling). With `after` set to an id that is not a sibling the CTE
 * is empty (the caller reports sibling_not_found).
 */
function posCte(
  table: 'content_modules' | 'content_items',
  tenantId: string,
  scope: SQL,
  after: After,
  exclude?: string,
): SQL {
  const t = sql.raw(`lms.${table}`);
  const others = exclude ? sql`AND s.id <> ${exclude}::uuid` : sql``;
  if (after === undefined) {
    return sql`pos AS (SELECT lms.position_between(
      (SELECT max(s.position) FROM ${t} s WHERE s.tenant_id = ${tenantId}::uuid AND ${scope} ${others}), NULL) AS p)`;
  }
  if (after === null) {
    return sql`pos AS (SELECT lms.position_between(NULL,
      (SELECT min(s.position) FROM ${t} s WHERE s.tenant_id = ${tenantId}::uuid AND ${scope} ${others})) AS p)`;
  }
  const notSelf = exclude ? sql`AND a.id <> ${exclude}::uuid` : sql``;
  return sql`pos AS (
    SELECT lms.position_between(a.position,
             (SELECT min(s.position) FROM ${t} s
               WHERE s.tenant_id = ${tenantId}::uuid AND ${scope} ${others} AND s.position > a.position)) AS p
      FROM ${t} a
     WHERE a.tenant_id = ${tenantId}::uuid AND a.id = ${after}::uuid ${notSelf}
       AND EXISTS (SELECT 1 FROM ${t} s WHERE s.tenant_id = a.tenant_id AND s.id = a.id AND ${scope}))`;
}

/** The effective opening time and lock of an item (alias i, its module m) for the caller. */
const lockOf = (staff: SQL): SQL => sql`
  SELECT greatest(i.available_from, mo.available_from) AS eff,
         (NOT ${staff} AND greatest(i.available_from, mo.available_from) > now()) AS locked`;

/** One item as JSON for the caller (alias i: item, m: module, f: file). */
const itemJson = (staff: SQL, withBody: boolean, from: SQL = sql`lms.content_items`): SQL => sql`
  SELECT jsonb_build_object(
    'id', i.id, 'moduleId', i.module_id, 'kind', i.kind, 'title', i.title, 'published', i.published,
    'required', i.required, 'completion', i.completion,
    'hasProgress', (${staff} AND EXISTS (SELECT 1 FROM lms.item_progress ip
                     WHERE ip.tenant_id = i.tenant_id AND ip.item_id = i.id)),
    'availableFrom', l.eff, 'locked', l.locked,
    'url', CASE WHEN l.locked THEN NULL ELSE i.url END,
    'file', CASE WHEN l.locked OR f.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', f.id, 'name', f.original_name, 'size', f.size_bytes, 'contentType', f.content_type) END,
    'video', CASE WHEN l.locked OR vd.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', vd.id, 'status', vd.status, 'progress', vd.progress::int, 'durationMs', vd.duration_ms) END,
    'hasBody', (i.body IS NOT NULL AND NOT l.locked),
    ${withBody ? sql`'body', CASE WHEN l.locked THEN NULL ELSE i.body END,` : sql``}
    'updatedAt', i.updated_at) AS j, i.position AS pos
    FROM ${from} i
    JOIN lms.content_modules mo ON mo.tenant_id = i.tenant_id AND mo.id = i.module_id
    LEFT JOIN lms.files f ON f.tenant_id = i.tenant_id AND f.id = i.file_id AND f.status = 'ready'
    LEFT JOIN lms.video_assets vd ON vd.tenant_id = i.tenant_id AND vd.id = i.video_asset_id
    CROSS JOIN LATERAL (${lockOf(staff)}) l`;

export function createContentRepository() {
  return {
    /** The whole outline in ONE statement: modules with their items (no bodies), shaped for the caller. */
    async outline(tx: Executor, a: AccessSpec): Promise<{ acc: AccessRow | null; modules: Row[] }> {
      const staff = staffOf(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
          coalesce((
            SELECT jsonb_agg(mm.j ORDER BY mm.pos) FROM (
              SELECT m.position AS pos, jsonb_build_object(
                'id', m.id, 'title', m.title, 'published', m.published, 'availableFrom', m.available_from,
                'hasProgress', (${staff} AND EXISTS (SELECT 1 FROM lms.item_progress ip
                                  JOIN lms.content_items ci ON ci.tenant_id = ip.tenant_id AND ci.id = ip.item_id
                                 WHERE ip.tenant_id = m.tenant_id AND ci.module_id = m.id)),
                'items', coalesce((
                  SELECT jsonb_agg(x.j ORDER BY x.pos) FROM (
                    ${itemJson(staff, false)}
                    WHERE i.tenant_id = ${a.tenantId}::uuid AND i.module_id = m.id AND i.deleted_at IS NULL
                      AND (${staff} OR i.published)) x), '[]'::jsonb)) AS j
                FROM lms.content_modules m
               WHERE m.tenant_id = ${a.tenantId}::uuid AND m.offering_id = ${a.offeringId}::uuid AND m.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)
                 AND (${staff} OR m.published)) mm), '[]'::jsonb) AS modules`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), modules: (r?.modules as Row[] | undefined) ?? [] };
    },

    /** One item (with its body) as the caller may see it; null for a missing or (for a learner) hidden one. */
    async getItem(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; item: Row | null }> {
      const staff = staffOf(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT x.j FROM (
                  ${itemJson(staff, true)}
                  WHERE i.tenant_id = ${a.tenantId}::uuid AND i.offering_id = ${a.offeringId}::uuid
                    AND i.id = ${itemId}::uuid AND i.deleted_at IS NULL AND mo.deleted_at IS NULL
                    AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)
                    AND (${staff} OR (i.published AND mo.published))) x) AS item`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), item: (r?.item as Row | null) ?? null };
    },

    /** The stored file of an item the caller may open (not locked, not hidden): for a signed download URL. */
    async itemFile(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; file: Row | null; locked: boolean }> {
      const staff = staffOf(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(r) FROM (
                  SELECT f.storage_key, f.original_name, f.content_type, l.locked
                    FROM lms.content_items i
                    JOIN lms.content_modules mo ON mo.tenant_id = i.tenant_id AND mo.id = i.module_id
                    JOIN lms.files f ON f.tenant_id = i.tenant_id AND f.id = i.file_id AND f.status = 'ready'
                    CROSS JOIN LATERAL (${lockOf(staff)}) l
                   WHERE i.tenant_id = ${a.tenantId}::uuid AND i.offering_id = ${a.offeringId}::uuid
                     AND i.id = ${itemId}::uuid AND i.deleted_at IS NULL AND mo.deleted_at IS NULL
                    AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)
                     AND (${staff} OR (i.published AND mo.published))) r) AS file`);
      const r = res.rows[0];
      const file = (r?.file as Row | null) ?? null;
      return { acc: asAcc(r?.acc), file, locked: file?.locked === true };
    },

    /** The video of an item the caller may open (not locked, not hidden): for a playback session. */
    async itemVideo(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; video: Row | null; locked: boolean }> {
      const staff = staffOf(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(r) FROM (
                  SELECT va.id AS "assetId", va.status, va.duration_ms AS "durationMs", va.renditions, l.locked,
                         (SELECT ip.position_s FROM lms.item_progress ip
                            JOIN lms.course_participants cp ON cp.tenant_id = ip.tenant_id AND cp.id = ip.participant_id
                            JOIN lms.tenant_memberships ctm ON ctm.tenant_id = cp.tenant_id AND ctm.id = cp.membership_id
                           WHERE ip.tenant_id = i.tenant_id AND ip.item_id = i.id AND ctm.user_id = ${a.userId}::uuid
                           LIMIT 1) AS "resumeSeconds",
                         coalesce((SELECT jsonb_agg(jsonb_build_object('language', c.language, 'label', c.label)
                                                    ORDER BY c.language)
                                     FROM lms.video_captions c
                                    WHERE c.tenant_id = va.tenant_id AND c.asset_id = va.id), '[]'::jsonb) AS captions
                    FROM lms.content_items i
                    JOIN lms.content_modules mo ON mo.tenant_id = i.tenant_id AND mo.id = i.module_id
                    JOIN lms.video_assets va ON va.tenant_id = i.tenant_id AND va.id = i.video_asset_id
                    CROSS JOIN LATERAL (${lockOf(staff)}) l
                   WHERE i.tenant_id = ${a.tenantId}::uuid AND i.offering_id = ${a.offeringId}::uuid
                     AND i.id = ${itemId}::uuid AND i.deleted_at IS NULL AND mo.deleted_at IS NULL
                    AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)
                     AND (${staff} OR (i.published AND mo.published))) r) AS video`);
      const r = res.rows[0];
      const video = (r?.video as Row | null) ?? null;
      return { acc: asAcc(r?.acc), video, locked: video?.locked === true };
    },

    // ---------------------------------------------------------------- modules
    async createModule(
      tx: Executor,
      a: AccessSpec,
      v: { id: string; title: string; after: After },
    ): Promise<{ acc: AccessRow | null; posFound: boolean; row: Row | null }> {
      const scope = sql`s.offering_id = ${a.offeringId}::uuid`;
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        ${posCte('content_modules', a.tenantId, scope, v.after)},
        ins AS (
          INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position)
          SELECT ${v.id}::uuid, ${a.tenantId}::uuid, acc.id, ${v.title}, pos.p FROM acc, pos WHERE ${may}
          RETURNING id, title, published, available_from)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM pos) AS pos_found,
               (SELECT to_jsonb(ins) FROM ins) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        posFound: r?.pos_found === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    async updateModule(
      tx: Executor,
      a: AccessSpec,
      moduleId: string,
      v: { title?: string; published?: boolean; availableFrom?: string | null },
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const set: SQL[] = [];
      if (v.title !== undefined) set.push(sql`title = ${v.title}`);
      if (v.published !== undefined) set.push(sql`published = ${v.published}`);
      if (v.availableFrom !== undefined)
        set.push(sql`available_from = ${v.availableFrom}::timestamptz`);
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        upd AS (
          UPDATE lms.content_modules x SET ${sql.join(set, sql`, `)}, updated_at = now() FROM acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${moduleId}::uuid AND x.deleted_at IS NULL AND ${may}
          RETURNING x.id, x.title, x.published, x.available_from)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT to_jsonb(upd) FROM upd) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async moveModule(
      tx: Executor,
      a: AccessSpec,
      moduleId: string,
      after: string | null,
    ): Promise<{ acc: AccessRow | null; posFound: boolean; row: Row | null }> {
      const scope = sql`s.offering_id = ${a.offeringId}::uuid`;
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        ${posCte('content_modules', a.tenantId, scope, after, moduleId)},
        upd AS (
          UPDATE lms.content_modules x SET position = pos.p, updated_at = now() FROM acc, pos
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${moduleId}::uuid AND x.deleted_at IS NULL AND ${may}
          RETURNING x.id, x.title, x.published, x.available_from)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM pos) AS pos_found,
               (SELECT to_jsonb(upd) FROM upd) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        posFound: r?.pos_found === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    /**
     * Deletes a module, unless something in it has learner progress: then the module and ALL its items are
     * archived (`deleted_at`) and the progress stays as history.
     */
    async deleteModule(
      tx: Executor,
      a: AccessSpec,
      moduleId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; deleted: boolean; archived: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        cur AS (
          SELECT x.id,
                 EXISTS (SELECT 1 FROM lms.item_progress p JOIN lms.content_items i
                           ON i.tenant_id = p.tenant_id AND i.id = p.item_id
                          WHERE p.tenant_id = x.tenant_id AND i.module_id = x.id) AS has_progress
            FROM lms.content_modules x, acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${moduleId}::uuid
             AND x.deleted_at IS NULL AND ${may}),
        del AS (
          DELETE FROM lms.content_modules x USING cur
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.id = cur.id AND NOT cur.has_progress
          RETURNING x.id),
        arc_items AS (
          UPDATE lms.content_items i SET deleted_at = now(), updated_at = now() FROM cur
           WHERE i.tenant_id = ${a.tenantId}::uuid AND i.module_id = cur.id AND cur.has_progress AND i.deleted_at IS NULL
          RETURNING i.id),
        arc AS (
          UPDATE lms.content_modules x SET deleted_at = now(), updated_at = now() FROM cur
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.id = cur.id AND cur.has_progress
          RETURNING x.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM cur) AS found,
               EXISTS (SELECT 1 FROM del) AS deleted, EXISTS (SELECT 1 FROM arc) AS archived,
               (SELECT count(*) FROM arc_items) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        deleted: r?.deleted === true,
        archived: r?.archived === true,
      };
    },

    // ---------------------------------------------------------------- items
    async createItem(
      tx: Executor,
      a: AccessSpec,
      moduleId: string,
      v: {
        id: string;
        kind: string;
        title: string;
        body: unknown;
        fileId: string | null;
        videoId: string | null;
        url: string | null;
        published: boolean;
        availableFrom: string | null;
        required: boolean;
        completion: string;
        after: After;
      },
      createdBy: string,
    ): Promise<{
      acc: AccessRow | null;
      moduleFound: boolean;
      posFound: boolean;
      fileOk: boolean;
      videoOk: boolean;
      item: Row | null;
    }> {
      const scope = sql`s.module_id = ${moduleId}::uuid`;
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        mod AS (SELECT id FROM lms.content_modules
                 WHERE tenant_id = ${a.tenantId}::uuid AND offering_id = ${a.offeringId}::uuid AND id = ${moduleId}::uuid
                   AND deleted_at IS NULL),
        ${posCte('content_items', a.tenantId, scope, v.after)},
        fl AS (
          SELECT f.id FROM lms.files f
           WHERE f.tenant_id = ${a.tenantId}::uuid AND f.id = ${v.fileId}::uuid AND f.status = 'ready'
             AND (f.created_by = ${createdBy}::uuid
                  OR EXISTS (SELECT 1 FROM lms.content_items ci
                              WHERE ci.tenant_id = f.tenant_id AND ci.offering_id = ${a.offeringId}::uuid
                                AND ci.file_id = f.id))),
        vd AS (
          SELECT va.id FROM lms.video_assets va
           WHERE va.tenant_id = ${a.tenantId}::uuid AND va.id = ${v.videoId}::uuid AND va.status = 'ready'
             AND (va.offering_id = ${a.offeringId}::uuid
                  OR EXISTS (SELECT 1 FROM lms.content_items ci
                              WHERE ci.tenant_id = va.tenant_id AND ci.offering_id = ${a.offeringId}::uuid
                                AND ci.video_asset_id = va.id))),
        ins AS (
          INSERT INTO lms.content_items
            (id, tenant_id, offering_id, module_id, kind, title, position, body, file_id, video_asset_id, url,
             published, available_from, required, completion, created_by)
          SELECT ${v.id}::uuid, ${a.tenantId}::uuid, acc.id, mod.id, ${v.kind}, ${v.title}, pos.p,
                 ${v.body === null ? null : JSON.stringify(v.body)}::jsonb, ${v.fileId}::uuid, ${v.videoId}::uuid,
                 ${v.url}, ${v.published}, ${v.availableFrom}::timestamptz, ${v.required}, ${v.completion}, ${createdBy}::uuid
            FROM acc, mod, pos
           WHERE ${may} AND (${v.fileId}::uuid IS NULL OR EXISTS (SELECT 1 FROM fl))
             AND (${v.videoId}::uuid IS NULL OR EXISTS (SELECT 1 FROM vd))
          RETURNING *)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM mod) AS module_found,
               EXISTS (SELECT 1 FROM pos) AS pos_found,
               (${v.fileId}::uuid IS NULL OR EXISTS (SELECT 1 FROM fl)) AS file_ok,
               (${v.videoId}::uuid IS NULL OR EXISTS (SELECT 1 FROM vd)) AS video_ok,
               (SELECT x.j FROM (${itemJson(sql`TRUE`, true, sql`ins`)}) x) AS item`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        moduleFound: r?.module_found === true,
        posFound: r?.pos_found === true,
        fileOk: r?.file_ok === true,
        videoOk: r?.video_ok === true,
        item: (r?.item as Row | null) ?? null,
      };
    },

    async updateItem(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      v: {
        title?: string;
        body?: unknown;
        fileId?: string;
        videoId?: string;
        url?: string;
        published?: boolean;
        availableFrom?: string | null;
        required?: boolean;
        completion?: string;
      },
      actor: string,
    ): Promise<{ acc: AccessRow | null; fileOk: boolean; videoOk: boolean; item: Row | null }> {
      const set: SQL[] = [];
      if (v.title !== undefined) set.push(sql`title = ${v.title}`);
      if (v.body !== undefined) set.push(sql`body = ${JSON.stringify(v.body)}::jsonb`);
      if (v.url !== undefined) set.push(sql`url = ${v.url}`);
      if (v.fileId !== undefined) set.push(sql`file_id = ${v.fileId}::uuid`);
      if (v.videoId !== undefined) set.push(sql`video_asset_id = ${v.videoId}::uuid`);
      if (v.published !== undefined) set.push(sql`published = ${v.published}`);
      if (v.required !== undefined) set.push(sql`required = ${v.required}`);
      if (v.completion !== undefined) set.push(sql`completion = ${v.completion}`);
      if (v.availableFrom !== undefined)
        set.push(sql`available_from = ${v.availableFrom}::timestamptz`);
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        fl AS (
          SELECT f.id FROM lms.files f
           WHERE f.tenant_id = ${a.tenantId}::uuid AND f.id = ${v.fileId ?? null}::uuid AND f.status = 'ready'
             AND (f.created_by = ${actor}::uuid
                  OR EXISTS (SELECT 1 FROM lms.content_items ci
                              WHERE ci.tenant_id = f.tenant_id AND ci.offering_id = ${a.offeringId}::uuid
                                AND ci.file_id = f.id))),
        vd AS (
          SELECT va.id FROM lms.video_assets va
           WHERE va.tenant_id = ${a.tenantId}::uuid AND va.id = ${v.videoId ?? null}::uuid AND va.status = 'ready'
             AND (va.offering_id = ${a.offeringId}::uuid
                  OR EXISTS (SELECT 1 FROM lms.content_items ci
                              WHERE ci.tenant_id = va.tenant_id AND ci.offering_id = ${a.offeringId}::uuid
                                AND ci.video_asset_id = va.id))),
        upd AS (
          UPDATE lms.content_items x SET ${sql.join(set, sql`, `)}, updated_at = now() FROM acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${itemId}::uuid AND x.deleted_at IS NULL AND ${may}
             AND (${v.fileId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM fl))
             AND (${v.videoId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM vd))
          RETURNING x.*)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (${v.fileId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM fl)) AS file_ok,
               (${v.videoId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM vd)) AS video_ok,
               (SELECT x.j FROM (${itemJson(sql`TRUE`, true, sql`upd`)}) x) AS item`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        fileOk: r?.file_ok === true,
        videoOk: r?.video_ok === true,
        item: (r?.item as Row | null) ?? null,
      };
    },

    async moveItem(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      to: { moduleId?: string | undefined; after: string | null },
    ): Promise<{ acc: AccessRow | null; posFound: boolean; item: Row | null }> {
      // the module it ends up in: the requested one, else the one it is in now
      const target = to.moduleId
        ? sql`${to.moduleId}::uuid`
        : sql`(SELECT module_id FROM lms.content_items WHERE tenant_id = ${a.tenantId}::uuid AND id = ${itemId}::uuid)`;
      const scope = sql`s.module_id = ${target}`;
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        ${posCte('content_items', a.tenantId, scope, to.after, itemId)},
        upd AS (
          UPDATE lms.content_items x SET position = pos.p, module_id = ${target}, updated_at = now() FROM acc, pos
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${itemId}::uuid AND x.deleted_at IS NULL AND ${may}
          RETURNING x.*)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM pos) AS pos_found,
               (SELECT x.j FROM (${itemJson(sql`TRUE`, true, sql`upd`)}) x) AS item`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        posFound: r?.pos_found === true,
        item: (r?.item as Row | null) ?? null,
      };
    },

    /**
     * Deletes an item, unless it has learner progress: then it is archived (`deleted_at`): gone from outlines,
     * percentages and the builder, its progress kept as history.
     */
    async deleteItem(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; deleted: boolean; archived: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        cur AS (
          SELECT x.id,
                 EXISTS (SELECT 1 FROM lms.item_progress p
                          WHERE p.tenant_id = x.tenant_id AND p.item_id = x.id) AS has_progress
            FROM lms.content_items x, acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${itemId}::uuid
             AND x.deleted_at IS NULL AND ${may}),
        del AS (
          DELETE FROM lms.content_items x USING cur
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.id = cur.id AND NOT cur.has_progress
          RETURNING x.id),
        arc AS (
          UPDATE lms.content_items x SET deleted_at = now(), updated_at = now() FROM cur
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.id = cur.id AND cur.has_progress
          RETURNING x.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM cur) AS found,
               EXISTS (SELECT 1 FROM del) AS deleted, EXISTS (SELECT 1 FROM arc) AS archived`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        deleted: r?.deleted === true,
        archived: r?.archived === true,
      };
    },

    // ---------------------------------------------------------------- copy
    /**
     * Copies modules and items of `source` to the end of `target`, set-based and in one statement. Items are
     * copied unpublished and unlocked; FILE ROWS ARE SHARED (the copy points at the same files). Run for the
     * caller (`gates` given): copies at once when the source has at most `inlineLimit` items, else marks the
     * target `running` and queues the `content.copy` job. Run by the job (`gates` omitted): copies, no checks.
     */
    async copy(
      tx: Executor,
      v: {
        tenantId: string;
        sourceId: string;
        targetId: string;
        actorUserId: string;
        /** days to move the dates of assessments and assignments; null = the difference of the term start dates */
        shiftDays?: number | null;
        clearDates?: boolean;
      },
      gates?: { target: AccessSpec; source: AccessSpec; inlineLimit: number },
    ): Promise<{
      targetAcc: AccessRow | null;
      sourceAcc: AccessRow | null;
      busy: boolean;
      mode: 'done' | 'queued' | null;
      modules: number;
      items: number;
      assessments: number;
      assignments: number;
    }> {
      const t = sql`${v.tenantId}::uuid`;
      const target = sql`${v.targetId}::uuid`;
      const sh = (col: string) =>
        sql`(CASE WHEN (SELECT clear FROM sh) THEN NULL ELSE ${sql.raw(col)} + make_interval(days => (SELECT d FROM sh)) END)`;
      const inlineOk = gates ? sql`(SELECT n FROM cnt) <= ${gates.inlineLimit}` : sql`TRUE`;
      const allowed = gates
        ? sql`EXISTS (SELECT 1 FROM acc WHERE ${may}) AND EXISTS (SELECT 1 FROM src WHERE src.visible AND src.allowed)
              AND NOT (SELECT busy FROM tgt)`
        : sql`coalesce((SELECT busy FROM tgt), false)`;
      const accs = gates
        ? sql`${accessCte({ ...gates.target, lock: true })}, ${accessCte({ ...gates.source, name: 'src' })},`
        : sql``;
      const res = await tx.execute(sql`
        WITH ${accs}
        tgt AS (SELECT (copy_status = 'running') AS busy FROM lms.course_offerings
                 WHERE tenant_id = ${t} AND id = ${v.targetId}::uuid),
        cnt AS (SELECT count(*)::int AS n FROM lms.content_items
                 WHERE tenant_id = ${t} AND offering_id = ${v.sourceId}::uuid AND deleted_at IS NULL),
        go AS (SELECT (${allowed}) AS ok, (${inlineOk}) AS inline),
        base AS (SELECT coalesce((SELECT max(position) FROM lms.content_modules
                                   WHERE tenant_id = ${t} AND offering_id = ${v.targetId}::uuid), '') AS prefix),
        sh AS (
          SELECT coalesce(${v.shiftDays ?? null}::int, (tt.start_date - st.start_date)) AS d,
                 ${v.clearDates === true}::boolean AS clear
            FROM lms.course_offerings so JOIN lms.terms st ON st.tenant_id = so.tenant_id AND st.id = so.term_id,
                 lms.course_offerings tg JOIN lms.terms tt ON tt.tenant_id = tg.tenant_id AND tt.id = tg.term_id
           WHERE so.tenant_id = ${t} AND so.id = ${v.sourceId}::uuid AND tg.tenant_id = ${t} AND tg.id = ${target}),
        same AS (
          SELECT (a.course_id = b.course_id) AS ok, b.course_id AS target_course
            FROM lms.course_offerings a, lms.course_offerings b
           WHERE a.tenant_id = ${t} AND a.id = ${v.sourceId}::uuid AND b.tenant_id = ${t} AND b.id = ${target}),
        mm AS (
          SELECT m.id AS old_id, lms.uuid_v7() AS new_id, m.title, base.prefix || m.position AS position
            FROM lms.content_modules m, base, go
           WHERE m.tenant_id = ${t} AND m.offering_id = ${v.sourceId}::uuid AND m.deleted_at IS NULL
             AND go.ok AND go.inline),
        nm AS (
          INSERT INTO lms.content_modules (id, tenant_id, offering_id, title, position, published, available_from)
          SELECT new_id, ${t}, ${v.targetId}::uuid, title, position, false, NULL FROM mm
          RETURNING id),
        mi AS (
          SELECT i.id AS old_id, lms.uuid_v7() AS new_id, mm.new_id AS module_id, i.kind, i.title, i.position, i.body,
                 i.file_id, i.video_asset_id, i.url, i.required, i.completion
            FROM lms.content_items i JOIN mm ON mm.old_id = i.module_id
           WHERE i.tenant_id = ${t} AND i.deleted_at IS NULL),
        ni AS (
          INSERT INTO lms.content_items
            (id, tenant_id, offering_id, module_id, kind, title, position, body, file_id, video_asset_id, url,
             published, available_from, required, completion, created_by)
          SELECT mi.new_id, ${t}, ${target}, mi.module_id, mi.kind, mi.title, mi.position, mi.body, mi.file_id,
                 mi.video_asset_id, mi.url, false, NULL, mi.required, mi.completion, ${v.actorUserId}::uuid
            FROM mi
          RETURNING id),
        -- assessments: the settings (dates moved) and, within the SAME course, the questions. Never attempts, grades or
        -- accommodations. The database also makes a default settings row for every assessment item (ON CONFLICT DO NOTHING).
        na AS (
          INSERT INTO lms.assessments
            (tenant_id, item_id, offering_id, course_id, kind, opens_at, closes_at, time_limit_minutes, attempts_allowed,
             scoring, shuffle_questions, shuffle_options, passing_score, results_visibility, answers_visibility)
          SELECT ${t}, mi.new_id, ${target}, (SELECT target_course FROM same), s.kind, ${sh('s.opens_at')}, ${sh('s.closes_at')},
                 s.time_limit_minutes, s.attempts_allowed, s.scoring, s.shuffle_questions, s.shuffle_options, s.passing_score,
                 CASE WHEN (SELECT clear FROM sh) AND s.results_visibility = 'after_close' THEN 'manual' ELSE s.results_visibility END,
                 CASE WHEN (SELECT clear FROM sh) AND s.answers_visibility = 'after_close' THEN 'after_release' ELSE s.answers_visibility END
            FROM mi JOIN lms.assessments s ON s.tenant_id = ${t} AND s.item_id = mi.old_id
           WHERE mi.kind = 'assessment'
          RETURNING item_id),
        ns AS (
          INSERT INTO lms.assessment_slots
            (tenant_id, assessment_item_id, position, kind, question_id, tag, difficulty, count, points)
          SELECT ${t}, mi.new_id, sl.position, sl.kind, sl.question_id, sl.tag, sl.difficulty, sl.count, sl.points
            FROM mi JOIN lms.assessment_slots sl ON sl.tenant_id = ${t} AND sl.assessment_item_id = mi.old_id
           WHERE mi.kind = 'assessment' AND (SELECT ok FROM same)
          RETURNING 1),
        -- assignments: settings (dates moved), instructions, attachments (the file rows are shared) and, within the SAME
        -- course, the rubric. Never submissions, grades, extensions, drafts or the blind keys.
        nas AS (
          INSERT INTO lms.assignments
            (tenant_id, item_id, offering_id, course_id, instructions, opens_at, due_at, late_policy, late_cutoff_at,
             penalty_kind, penalty_value, penalty_cap, max_points, passing_score, allow_file, allow_text, allow_link,
             max_files, max_file_mb, resubmission_allowed, anonymous_grading, release_mode, rubric_id, rubric_version_id)
          SELECT ${t}, mi.new_id, ${target}, (SELECT target_course FROM same), s.instructions, ${sh('s.opens_at')}, ${sh('s.due_at')},
                 CASE WHEN (SELECT clear FROM sh) THEN 'none' ELSE s.late_policy END, ${sh('s.late_cutoff_at')},
                 s.penalty_kind, s.penalty_value, s.penalty_cap, s.max_points, s.passing_score, s.allow_file, s.allow_text,
                 s.allow_link, s.max_files, s.max_file_mb, s.resubmission_allowed, s.anonymous_grading, s.release_mode,
                 CASE WHEN (SELECT ok FROM same) THEN s.rubric_id END,
                 CASE WHEN (SELECT ok FROM same) THEN s.rubric_version_id END
            FROM mi JOIN lms.assignments s ON s.tenant_id = ${t} AND s.item_id = mi.old_id
           WHERE mi.kind = 'assignment'
          RETURNING item_id),
        nat AS (
          INSERT INTO lms.assignment_attachments (tenant_id, assignment_item_id, file_id, position)
          SELECT ${t}, mi.new_id, x.file_id, x.position
            FROM mi JOIN lms.assignment_attachments x ON x.tenant_id = ${t} AND x.assignment_item_id = mi.old_id
           WHERE mi.kind = 'assignment'
          RETURNING 1),
        queued AS (
          UPDATE lms.course_offerings SET copy_status = 'running', updated_at = now()
           WHERE tenant_id = ${t} AND id = ${v.targetId}::uuid AND (SELECT ok AND NOT inline FROM go)
          RETURNING id),
        fin AS (
          UPDATE lms.course_offerings SET copy_status = 'done', updated_at = now()
           WHERE tenant_id = ${t} AND id = ${v.targetId}::uuid AND ${gates ? sql`FALSE` : sql`(SELECT ok FROM go)`}
          RETURNING id),
        job AS (
          INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
          SELECT lms.uuid_v7(), 'content.copy', ${t},
                 jsonb_build_object('sourceId', ${v.sourceId}::text, 'targetId', ${v.targetId}::text,
                                    'actorUserId', ${v.actorUserId}::text, 'shiftDays', (SELECT d FROM sh),
                                    'clearDates', (SELECT clear FROM sh)), 3
            FROM queued
          RETURNING id)
        SELECT ${gates ? sql`(SELECT to_jsonb(acc) FROM acc)` : sql`NULL::jsonb`} AS target_acc,
               ${gates ? sql`(SELECT to_jsonb(src) FROM src)` : sql`NULL::jsonb`} AS source_acc,
               coalesce((SELECT busy FROM tgt), false) AS busy,
               CASE WHEN EXISTS (SELECT 1 FROM queued) THEN 'queued'
                    WHEN EXISTS (SELECT 1 FROM nm) OR (SELECT ok AND inline FROM go) THEN 'done' END AS mode,
               (SELECT count(*) FROM nm)::int AS modules, (SELECT count(*) FROM ni)::int AS items,
               (SELECT count(*) FROM na)::int AS assessments, (SELECT count(*) FROM nas)::int AS assignments,
               (SELECT count(*) FROM ns)::int + (SELECT count(*) FROM nat)::int AS extras`);
      const r = res.rows[0];
      return {
        targetAcc: asAcc(r?.target_acc),
        sourceAcc: asAcc(r?.source_acc),
        busy: r?.busy === true,
        mode: (r?.mode as 'done' | 'queued' | null) ?? null,
        modules: Number(r?.modules ?? 0),
        items: Number(r?.items ?? 0),
        assessments: Number(r?.assessments ?? 0),
        assignments: Number(r?.assignments ?? 0),
      };
    },

    /**
     * What a copy would do, without doing it: both offerings' terms, the proposed shift, and the assessments and
     * assignments with their current dates. Same gates as the copy.
     */
    async copyPreview(
      tx: Executor,
      v: { tenantId: string; sourceId: string; targetId: string },
      gates: { target: AccessSpec; source: AccessSpec },
    ): Promise<{
      targetAcc: AccessRow | null;
      sourceAcc: AccessRow | null;
      row: Record<string, unknown> | null;
    }> {
      const t = sql`${v.tenantId}::uuid`;
      const info = (alias: string, id: string) => sql`${sql.raw(alias)} AS (
        SELECT o.id, o.course_id, coalesce(o.title_override, c.title) AS title, tm.name AS term_name, tm.start_date
          FROM lms.course_offerings o
          JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
          JOIN lms.terms tm ON tm.tenant_id = o.tenant_id AND tm.id = o.term_id
         WHERE o.tenant_id = ${t} AND o.id = ${id}::uuid)`;
      const res = await tx.execute(sql`
        WITH ${accessCte(gates.target)}, ${accessCte({ ...gates.source, name: 'src' })},
        ${info('si', v.sourceId)}, ${info('ti', v.targetId)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS target_acc, (SELECT to_jsonb(src) FROM src) AS source_acc,
               (SELECT jsonb_build_object(
                  'source', jsonb_build_object('id', si.id, 'title', si.title, 'termName', si.term_name, 'termStart', si.start_date),
                  'target', jsonb_build_object('id', ti.id, 'title', ti.title, 'termName', ti.term_name, 'termStart', ti.start_date),
                  'defaultShiftDays', (ti.start_date - si.start_date), 'sameCourse', si.course_id = ti.course_id,
                  'items', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                             'kind', i.kind, 'title', i.title, 'moduleTitle', m.title,
                             'opensAt', CASE i.kind WHEN 'assessment' THEN a.opens_at ELSE g.opens_at END,
                             'endsAt', CASE i.kind WHEN 'assessment' THEN a.closes_at ELSE g.due_at END,
                             'lateCutoffAt', g.late_cutoff_at,
                             'copiesQuestions', si.course_id = ti.course_id)
                             ORDER BY m.position, i.position)
                      FROM lms.content_items i
                      JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
                      LEFT JOIN lms.assessments a ON a.tenant_id = i.tenant_id AND a.item_id = i.id AND i.kind = 'assessment'
                      LEFT JOIN lms.assignments g ON g.tenant_id = i.tenant_id AND g.item_id = i.id AND i.kind = 'assignment'
                     WHERE i.tenant_id = ${t} AND i.offering_id = ${v.sourceId}::uuid AND i.deleted_at IS NULL
                       AND m.deleted_at IS NULL AND i.kind IN ('assessment', 'assignment')
                       AND EXISTS (SELECT 1 FROM src WHERE src.visible AND src.allowed)), '[]'::jsonb))
                  FROM si, ti) AS row`);
      const r = res.rows[0];
      return {
        targetAcc: asAcc(r?.target_acc),
        sourceAcc: asAcc(r?.source_acc),
        row: (r?.row as Record<string, unknown> | null) ?? null,
      };
    },

    /** The job gave up: record it on the offering. */
    async setCopyStatus(
      tx: Executor,
      tenantId: string,
      offeringId: string,
      status: 'failed',
    ): Promise<void> {
      await tx.execute(sql`
        UPDATE lms.course_offerings SET copy_status = ${status}, updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND id = ${offeringId}::uuid`);
    },
  };
}
export type ContentRepository = ReturnType<typeof createContentRepository>;

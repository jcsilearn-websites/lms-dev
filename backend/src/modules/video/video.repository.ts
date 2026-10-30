import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. One statement per function; every decision about WHO may do it is inside that statement (the access
// CTE `acc`), so there is no check-then-act gap.
export type Row = Record<string, unknown>;

const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const asRow = (v: unknown): Row | null => (v as Row | null) ?? null;

/** The video as the API shows it (camelCase JSON), from a row aliased `v`. */
const assetJson = sql`jsonb_build_object(
  'id', v.id, 'offeringId', v.offering_id, 'fileName', v.original_name, 'status', v.status,
  'progress', v.progress::int, 'uploadOffset', v.upload_offset, 'size', v.declared_size,
  'durationMs', v.duration_ms, 'width', v.width, 'height', v.height, 'hasAudio', v.has_audio,
  'renditions', v.renditions,
  'captions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'language', c.language,
                                                            'label', c.label, 'sizeBytes', c.size_bytes)
                                         ORDER BY c.language)
                          FROM lms.video_captions c WHERE c.tenant_id = v.tenant_id AND c.asset_id = v.id),
                       '[]'::jsonb),
  'error', CASE WHEN v.error_code IS NULL THEN NULL
                ELSE jsonb_build_object('code', v.error_code, 'message', v.error_message) END,
  'sourceKept', (v.source_key IS NOT NULL AND v.source_deleted_at IS NULL),
  'createdAt', v.created_at, 'readyAt', v.ready_at)`;

const may = sql`acc.visible AND acc.allowed AND acc.status <> 'archived'`;

export function createVideoRepository() {
  return {
    /** Records a new video for an offering the caller may edit (decided in the same statement). */
    async createAsset(
      tx: Executor,
      a: AccessSpec,
      v: { id: string; fileName: string; size: number; provider: string; sourceKey: string },
      createdBy: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        ins AS (
          INSERT INTO lms.video_assets
            (id, tenant_id, offering_id, created_by, original_name, provider, declared_size, source_key)
          SELECT ${v.id}::uuid, ${a.tenantId}::uuid, acc.id, ${createdBy}::uuid, ${v.fileName}, ${v.provider},
                 ${v.size}::bigint, ${v.sourceKey}
            FROM acc WHERE ${may}
          RETURNING *)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ${assetJson} FROM ins v) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: asRow(r?.row) };
    },

    /** One video of the offering, for an editor. */
    async getAsset(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${assetJson} FROM lms.video_assets v
                 WHERE v.tenant_id = ${a.tenantId}::uuid AND v.offering_id = ${a.offeringId}::uuid
                   AND v.id = ${videoId}::uuid
                   AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: asRow(r?.row) };
    },

    /**
     * Before a chunk is written: the video as it is now, and a note that the upload is alive (the abandoned-upload
     * purge counts from the last activity). `open` says whether it is still accepting data.
     */
    async touchUpload(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null; open: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        cur AS (
          SELECT v.* FROM lms.video_assets v
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.offering_id = ${a.offeringId}::uuid
             AND v.id = ${videoId}::uuid AND EXISTS (SELECT 1 FROM acc WHERE ${may})),
        upd AS (
          UPDATE lms.video_assets v SET last_activity_at = now()
            FROM cur WHERE v.tenant_id = cur.tenant_id AND v.id = cur.id AND v.status = 'uploading'
          RETURNING v.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ${assetJson} FROM cur v) AS row,
               EXISTS (SELECT 1 FROM upd) AS open`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: asRow(r?.row), open: r?.open === true };
    },

    /**
     * The whole file is stored (`storedSize` is what the storage holds): uploading -> processing and queue the
     * `video` job, in ONE statement. Not updated when the size is not the announced one, or the video is not
     * uploading (`before` tells which).
     */
    async markUploaded(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
      storedSize: number,
    ): Promise<{
      acc: AccessRow | null;
      before: { status: string; size: number } | null;
      row: Row | null;
      queued: boolean;
    }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        cur AS (
          SELECT v.id, v.status, v.declared_size FROM lms.video_assets v
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.offering_id = ${a.offeringId}::uuid
             AND v.id = ${videoId}::uuid AND EXISTS (SELECT 1 FROM acc WHERE ${may})),
        upd AS (
          UPDATE lms.video_assets v
             SET status = 'processing', upload_offset = v.declared_size, progress = 0,
                 last_activity_at = now(), updated_at = now()
            FROM cur
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.id = cur.id AND cur.status = 'uploading'
             AND cur.declared_size = ${storedSize}::bigint
          RETURNING v.*),
        job AS (
          INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
          SELECT lms.uuid_v7(), 'video', ${a.tenantId}::uuid,
                 jsonb_build_object('assetId', upd.id::text), 3
            FROM upd
          RETURNING id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT jsonb_build_object('status', cur.status, 'size', cur.declared_size) FROM cur) AS before,
               (SELECT ${assetJson} FROM upd v) AS row, EXISTS (SELECT 1 FROM job) AS queued`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        before: (r?.before as { status: string; size: number } | null) ?? null,
        row: asRow(r?.row),
        queued: r?.queued === true,
      };
    },

    /** Deletes a video no item references. */
    async deleteAsset(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; used: boolean; deleted: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        cur AS (
          SELECT v.id, EXISTS (SELECT 1 FROM lms.content_items i
                                WHERE i.tenant_id = v.tenant_id AND i.video_asset_id = v.id) AS used
            FROM lms.video_assets v
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.offering_id = ${a.offeringId}::uuid
             AND v.id = ${videoId}::uuid AND EXISTS (SELECT 1 FROM acc WHERE ${may})),
        del AS (
          DELETE FROM lms.video_assets v USING cur
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.id = cur.id AND NOT cur.used
          RETURNING v.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM cur) AS found,
               coalesce((SELECT used FROM cur), false) AS used, EXISTS (SELECT 1 FROM del) AS deleted`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        used: r?.used === true,
        deleted: r?.deleted === true,
      };
    },

    // ---------------------------------------------------------------- captions
    /** Adds or replaces the captions of one language (at most `max` languages per video). */
    async upsertCaption(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
      c: { id: string; language: string; label: string; size: number; key: string },
      createdBy: string,
      max: number,
    ): Promise<{ acc: AccessRow | null; found: boolean; full: boolean; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        vid AS (
          SELECT v.id FROM lms.video_assets v
           WHERE v.tenant_id = ${a.tenantId}::uuid AND v.offering_id = ${a.offeringId}::uuid
             AND v.id = ${videoId}::uuid AND EXISTS (SELECT 1 FROM acc WHERE ${may})),
        cnt AS (
          SELECT count(*)::int AS n, coalesce(bool_or(language = ${c.language}), false) AS has
            FROM lms.video_captions
           WHERE tenant_id = ${a.tenantId}::uuid AND asset_id = ${videoId}::uuid),
        ins AS (
          INSERT INTO lms.video_captions
            (id, tenant_id, asset_id, language, label, size_bytes, storage_key, created_by)
          SELECT ${c.id}::uuid, ${a.tenantId}::uuid, vid.id, ${c.language}, ${c.label}, ${c.size}::int,
                 ${c.key}, ${createdBy}::uuid
            FROM vid, cnt WHERE cnt.n < ${max}::int OR cnt.has
          ON CONFLICT (tenant_id, asset_id, language)
            DO UPDATE SET label = EXCLUDED.label, size_bytes = EXCLUDED.size_bytes,
                          storage_key = EXCLUDED.storage_key, created_by = EXCLUDED.created_by
          RETURNING id, language, label, size_bytes AS "sizeBytes")
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM vid) AS found,
               (SELECT n >= ${max}::int AND NOT has FROM cnt) AS full, (SELECT to_jsonb(ins) FROM ins) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        full: r?.full === true,
        row: asRow(r?.row),
      };
    },

    async deleteCaption(
      tx: Executor,
      a: AccessSpec,
      videoId: string,
      language: string,
    ): Promise<{ acc: AccessRow | null; deleted: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        del AS (
          DELETE FROM lms.video_captions c
           USING lms.video_assets v, acc
           WHERE c.tenant_id = ${a.tenantId}::uuid AND c.asset_id = ${videoId}::uuid AND c.language = ${language}
             AND v.tenant_id = c.tenant_id AND v.id = c.asset_id AND v.offering_id = acc.id AND ${may}
          RETURNING c.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM del) AS deleted`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), deleted: r?.deleted === true };
    },

    // ---------------------------------------------------------------- the worker (tenant known, no request)
    async findForProcessing(tx: Executor, tenantId: string, id: string): Promise<Row | null> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          SELECT id, status, original_name, declared_size, source_key, offering_id
            FROM lms.video_assets WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid) r`);
      return asRow(res.rows[0]?.row);
    },

    /** What the probe found and the renditions that will be made. */
    async setProbed(
      tx: Executor,
      tenantId: string,
      id: string,
      v: {
        container: string;
        durationMs: number;
        width: number;
        height: number;
        hasAudio: boolean;
        sourceMeta: unknown;
        renditions: unknown;
      },
    ): Promise<boolean> {
      const res = await tx.execute(sql`
        UPDATE lms.video_assets SET container = ${v.container}, duration_ms = ${v.durationMs}::int,
               width = ${v.width}::int, height = ${v.height}::int, has_audio = ${v.hasAudio},
               source_meta = ${JSON.stringify(v.sourceMeta)}::jsonb, renditions = ${JSON.stringify(v.renditions)}::jsonb,
               progress = 0, last_activity_at = now(), updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'processing'`);
      return (res.rowCount ?? 0) > 0;
    },

    /** Progress only moves forward. Returns false when the video is gone or no longer processing. */
    async setProgress(
      tx: Executor,
      tenantId: string,
      id: string,
      percent: number,
    ): Promise<boolean> {
      const res = await tx.execute(sql`
        UPDATE lms.video_assets SET progress = ${percent}::smallint, last_activity_at = now(), updated_at = now()
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'processing'
           AND progress < ${percent}::smallint`);
      return (res.rowCount ?? 0) > 0;
    },

    async markReady(
      tx: Executor,
      tenantId: string,
      id: string,
      v: { renditions: unknown; hlsPrefix: string; posterKey: string; retentionDays: number },
    ): Promise<boolean> {
      const res = await tx.execute(sql`
        UPDATE lms.video_assets SET status = 'ready', progress = 100, renditions = ${JSON.stringify(v.renditions)}::jsonb,
               hls_prefix = ${v.hlsPrefix}, poster_key = ${v.posterKey}, error_code = NULL, error_message = NULL,
               ready_at = now(), last_activity_at = now(), updated_at = now(),
               source_expires_at = now() + make_interval(days => ${v.retentionDays}::int)
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'processing'`);
      return (res.rowCount ?? 0) > 0;
    },

    async markFailed(
      tx: Executor,
      tenantId: string,
      id: string,
      v: { code: string; message: string },
    ): Promise<boolean> {
      const res = await tx.execute(sql`
        UPDATE lms.video_assets SET status = 'failed', error_code = ${v.code}, error_message = ${v.message},
               last_activity_at = now(), updated_at = now(), source_expires_at = now() + interval '1 day'
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'processing'`);
      return (res.rowCount ?? 0) > 0;
    },

    // ---------------------------------------------------------------- sweeps (no tenant context)
    /** Deletes unreferenced videos past their grace period; returns what to remove from storage. */
    async purge(
      tx: Executor,
      graceHours: number,
      limit: number,
    ): Promise<{ tenantId: string; id: string }[]> {
      const res = await tx.execute(sql`
        SELECT tenant_id, id FROM lms.video_purge(make_interval(hours => ${graceHours}::int), ${limit}::int)`);
      return res.rows.map((r) => ({ tenantId: r.tenant_id as string, id: r.id as string }));
    },

    /** Marks the originals past retention as deleted; returns them so the objects can be removed. */
    async expireSources(tx: Executor, limit: number): Promise<{ tenantId: string; id: string }[]> {
      const res = await tx.execute(sql`
        SELECT tenant_id, id FROM lms.video_sources_expire(${limit}::int)`);
      return res.rows.map((r) => ({ tenantId: r.tenant_id as string, id: r.id as string }));
    },
  };
}
export type VideoRepository = ReturnType<typeof createVideoRepository>;

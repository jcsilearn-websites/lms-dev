import { type SQL, sql } from 'drizzle-orm';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';
import { type CourseAccessRow, type CourseAccessSpec, courseAccessCte } from '../courses';

// SQL only. Each function is ONE statement: the access CTE (is the caller allowed in this course) travels in the same
// statement as the work, so there is no check-then-act gap.
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): CourseAccessRow | null => (v as CourseAccessRow | null) ?? null;
const ok = sql`EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)`;

export interface ListFilter {
  type: string | null;
  difficulty: string | null;
  tag: string | null;
  status: 'active' | 'archived';
  limit: number;
  after: string | null;
}

export interface NewVersion {
  versionId: string;
  type: string;
  difficulty: string;
  presentation: unknown;
  answerKey: unknown;
  tags: string[];
  fileIds: string[];
  userId: string;
}

/** One question as the instructor sees it: the shown version, the newest version number and the tags. */
const questionJson = (q: SQL, v: SQL, latest: SQL): SQL => sql`jsonb_build_object(
  'id', ${q}.id, 'courseId', ${q}.course_id, 'status', ${q}.status, 'version', ${v}.version,
  'latestVersion', ${latest}, 'versionId', ${v}.id, 'type', ${v}.type, 'difficulty', ${v}.difficulty,
  'presentation', ${v}.presentation, 'answerKey', ${v}.answer_key,
  'tags', coalesce((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM lms.question_tags t
                     WHERE t.tenant_id = ${q}.tenant_id AND t.question_id = ${q}.id), '[]'::jsonb),
  'createdAt', ${q}.created_at, 'updatedAt', ${q}.updated_at)`;

/** Images of a version: ready PNG / JPEG files the caller uploaded, or that this course's questions already use. */
function fileCheck(a: CourseAccessSpec, fileIds: string[], userId: string): SQL {
  return sql`fl AS (
    SELECT f.id FROM lms.files f
     WHERE f.tenant_id = ${a.tenantId}::uuid AND f.id = ANY(${pgArray(fileIds)}::uuid[]) AND f.status = 'ready'
       AND f.content_type IN ('image/png', 'image/jpeg')
       AND (f.created_by = ${userId}::uuid
            OR EXISTS (SELECT 1 FROM lms.question_files qf
                         JOIN lms.question_versions qv ON qv.tenant_id = qf.tenant_id AND qv.id = qf.question_version_id
                         JOIN lms.questions qq ON qq.tenant_id = qv.tenant_id AND qq.id = qv.question_id
                        WHERE qf.tenant_id = f.tenant_id AND qf.file_id = f.id AND qq.course_id = ${a.courseId}::uuid))),
  files_ok AS (SELECT (SELECT count(*) FROM fl) = ${fileIds.length} AS ok)`;
}

export function createQuestionsRepository() {
  return {
    /** Only the access decision (the CSV template is static, but who may download it is not). */
    async access(tx: Executor, a: CourseAccessSpec): Promise<CourseAccessRow | null> {
      const res = await tx.execute(
        sql`WITH ${courseAccessCte(a)} SELECT to_jsonb(acc) AS acc FROM acc`,
      );
      return asAcc(res.rows[0]?.acc);
    },

    async list(
      tx: Executor,
      a: CourseAccessSpec,
      f: ListFilter,
    ): Promise<{ acc: CourseAccessRow | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        page AS (
          SELECT q.*, v.id AS vid
            FROM lms.questions q
            JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.id = q.current_version_id
           WHERE q.tenant_id = ${a.tenantId}::uuid AND q.course_id = ${a.courseId}::uuid AND ${ok}
             AND q.status = ${f.status}
             ${f.after ? sql`AND q.id < ${f.after}::uuid` : sql``}
             ${f.type ? sql`AND v.type = ${f.type}` : sql``}
             ${f.difficulty ? sql`AND v.difficulty = ${f.difficulty}` : sql``}
             ${
               f.tag
                 ? sql`AND EXISTS (SELECT 1 FROM lms.question_tags t WHERE t.tenant_id = q.tenant_id
                                    AND t.course_id = q.course_id AND t.tag = ${f.tag} AND t.question_id = q.id)`
                 : sql``
             }
           ORDER BY q.id DESC LIMIT ${f.limit + 1})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(${questionJson(sql`p`, sql`v`, sql`v.version`)} ORDER BY p.id DESC)
                           FROM page p JOIN lms.question_versions v ON v.tenant_id = p.tenant_id AND v.id = p.vid), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[]) ?? [] };
    },

    /** One question at a version (default: the current one); `null` row = no such question / version. */
    async get(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
      version: number | null,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null; versionMissing: boolean }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        q AS (SELECT * FROM lms.questions WHERE tenant_id = ${a.tenantId}::uuid AND course_id = ${a.courseId}::uuid
                 AND id = ${questionId}::uuid AND ${ok}),
        latest AS (SELECT cv.version FROM q JOIN lms.question_versions cv ON cv.tenant_id = q.tenant_id AND cv.id = q.current_version_id),
        v AS (SELECT sv.* FROM q JOIN lms.question_versions sv ON sv.tenant_id = q.tenant_id AND sv.question_id = q.id
               AND ${version === null ? sql`sv.id = q.current_version_id` : sql`sv.version = ${version}`})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${questionJson(sql`q`, sql`v`, sql`(SELECT version FROM latest)`)} FROM q, v) AS row,
               EXISTS (SELECT 1 FROM q) AS q_found`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        row: (r?.row as Row | null) ?? null,
        versionMissing: r?.q_found === true && !r?.row,
      };
    },

    async versions(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
    ): Promise<{ acc: CourseAccessRow | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(jsonb_build_object('version', v.version, 'versionId', v.id,
                          'current', v.id = q.current_version_id, 'createdAt', v.created_at,
                          'createdByName', u.display_name) ORDER BY v.version DESC)
                           FROM lms.questions q
                           JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.question_id = q.id
                           LEFT JOIN lms.users u ON u.id = v.created_by
                          WHERE q.tenant_id = ${a.tenantId}::uuid AND q.course_id = ${a.courseId}::uuid
                            AND q.id = ${questionId}::uuid AND ${ok}), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[]) ?? [] };
    },

    async tags(
      tx: Executor,
      a: CourseAccessSpec,
    ): Promise<{ acc: CourseAccessRow | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(jsonb_build_object('tag', x.tag, 'count', x.n) ORDER BY x.tag)
                           FROM (SELECT t.tag, count(*)::int AS n
                                   FROM lms.question_tags t
                                   JOIN lms.questions q ON q.tenant_id = t.tenant_id AND q.id = t.question_id
                                  WHERE t.tenant_id = ${a.tenantId}::uuid AND t.course_id = ${a.courseId}::uuid
                                    AND q.status = 'active' AND ${ok}
                                  GROUP BY t.tag) x), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[]) ?? [] };
    },

    /** A question and its first version, in one statement (the current-version key is deferred). */
    async create(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
      v: NewVersion,
    ): Promise<{ acc: CourseAccessRow | null; filesOk: boolean; createdAt: string | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}, ${fileCheck(a, v.fileIds, v.userId)},
        qn AS (
          INSERT INTO lms.questions (id, tenant_id, course_id, current_version_id, created_by)
          SELECT ${questionId}::uuid, ${a.tenantId}::uuid, acc.id, ${v.versionId}::uuid, ${v.userId}::uuid
            FROM acc, files_ok WHERE acc.visible AND acc.allowed AND files_ok.ok
          RETURNING id, created_at),
        ver AS (
          INSERT INTO lms.question_versions (id, tenant_id, question_id, version, type, difficulty, presentation, answer_key, created_by)
          SELECT ${v.versionId}::uuid, ${a.tenantId}::uuid, qn.id, 1, ${v.type}, ${v.difficulty},
                 ${JSON.stringify(v.presentation)}::jsonb, ${JSON.stringify(v.answerKey)}::jsonb, ${v.userId}::uuid
            FROM qn
          RETURNING id),
        tg AS (
          INSERT INTO lms.question_tags (tenant_id, course_id, question_id, tag)
          SELECT ${a.tenantId}::uuid, ${a.courseId}::uuid, qn.id, t.tag
            FROM qn, unnest(${pgArray(v.tags)}::text[]) t(tag)
          RETURNING 1),
        fi AS (
          INSERT INTO lms.question_files (tenant_id, question_version_id, file_id)
          SELECT ${a.tenantId}::uuid, ver.id, fl.id FROM ver, fl
          RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ok FROM files_ok) AS files_ok,
               (SELECT created_at FROM qn) AS created_at,
               (SELECT count(*) FROM ver) + (SELECT count(*) FROM tg) + (SELECT count(*) FROM fi) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        filesOk: r?.files_ok === true,
        createdAt: r?.created_at == null ? null : String(r.created_at),
      };
    },

    /**
     * A new version of a question, only when `expectedVersionId` is still the current one (an edit made on top of a
     * newer save by someone else is refused). Tags are replaced; images are referenced by the new version.
     */
    async addVersion(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
      expectedVersionId: string,
      v: NewVersion,
    ): Promise<{
      acc: CourseAccessRow | null;
      filesOk: boolean;
      found: boolean;
      version: number | null;
      createdAt: string | null;
      updatedAt: string | null;
    }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}, ${fileCheck(a, v.fileIds, v.userId)},
        q AS (SELECT q.id, q.current_version_id, q.created_at FROM lms.questions q
               WHERE q.tenant_id = ${a.tenantId}::uuid AND q.course_id = ${a.courseId}::uuid AND q.id = ${questionId}::uuid
                 AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed) FOR UPDATE),
        ver AS (
          INSERT INTO lms.question_versions (id, tenant_id, question_id, version, type, difficulty, presentation, answer_key, created_by)
          SELECT ${v.versionId}::uuid, ${a.tenantId}::uuid, q.id,
                 (SELECT max(x.version) FROM lms.question_versions x WHERE x.tenant_id = ${a.tenantId}::uuid AND x.question_id = q.id) + 1,
                 ${v.type}, ${v.difficulty}, ${JSON.stringify(v.presentation)}::jsonb, ${JSON.stringify(v.answerKey)}::jsonb, ${v.userId}::uuid
            FROM q, files_ok WHERE q.current_version_id = ${expectedVersionId}::uuid AND files_ok.ok
          RETURNING id, version),
        mv AS (
          UPDATE lms.questions SET current_version_id = ver.id, updated_at = now() FROM ver
           WHERE questions.tenant_id = ${a.tenantId}::uuid AND questions.id = ${questionId}::uuid RETURNING questions.updated_at),
        td AS (
          DELETE FROM lms.question_tags t USING ver
           WHERE t.tenant_id = ${a.tenantId}::uuid AND t.question_id = ${questionId}::uuid
             AND t.tag <> ALL(${pgArray(v.tags)}::text[]) RETURNING 1),
        ti AS (
          INSERT INTO lms.question_tags (tenant_id, course_id, question_id, tag)
          SELECT ${a.tenantId}::uuid, ${a.courseId}::uuid, ${questionId}::uuid, t.tag
            FROM ver, unnest(${pgArray(v.tags)}::text[]) t(tag)
          ON CONFLICT DO NOTHING RETURNING 1),
        fi AS (
          INSERT INTO lms.question_files (tenant_id, question_version_id, file_id)
          SELECT ${a.tenantId}::uuid, ver.id, fl.id FROM ver, fl RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ok FROM files_ok) AS files_ok,
               EXISTS (SELECT 1 FROM q) AS q_found, (SELECT version FROM ver) AS version,
               (SELECT created_at FROM q) AS created_at, (SELECT updated_at FROM mv) AS updated_at,
               (SELECT count(*) FROM mv) + (SELECT count(*) FROM td) + (SELECT count(*) FROM ti) + (SELECT count(*) FROM fi) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        filesOk: r?.files_ok === true,
        found: r?.q_found === true,
        version: r?.version == null ? null : Number(r.version),
        createdAt: r?.created_at == null ? null : String(r.created_at),
        updatedAt: r?.updated_at == null ? null : String(r.updated_at),
      };
    },

    async setStatus(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
      status: 'active' | 'archived',
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        upd AS (UPDATE lms.questions SET status = ${status}, updated_at = now()
                 WHERE tenant_id = ${a.tenantId}::uuid AND course_id = ${a.courseId}::uuid AND id = ${questionId}::uuid
                   AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed) RETURNING *)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${questionJson(sql`upd`, sql`v`, sql`v.version`)}
                  FROM upd JOIN lms.question_versions v ON v.tenant_id = upd.tenant_id AND v.id = upd.current_version_id) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    /** An image of a question (any version): the file row for a signed download. */
    async imageFile(
      tx: Executor,
      a: CourseAccessSpec,
      questionId: string,
      fileId: string,
    ): Promise<{ acc: CourseAccessRow | null; file: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(x) FROM (
                  SELECT f.storage_key, f.original_name, f.content_type
                    FROM lms.question_files qf
                    JOIN lms.question_versions qv ON qv.tenant_id = qf.tenant_id AND qv.id = qf.question_version_id
                    JOIN lms.files f ON f.tenant_id = qf.tenant_id AND f.id = qf.file_id AND f.status = 'ready'
                   WHERE qf.tenant_id = ${a.tenantId}::uuid AND qf.file_id = ${fileId}::uuid
                     AND qv.question_id = ${questionId}::uuid AND ${ok}
                   LIMIT 1) x) AS file`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), file: (r?.file as Row | null) ?? null };
    },

    // ---------------------------------------------------------------- CSV import
    async stageImport(
      tx: Executor,
      a: CourseAccessSpec,
      imp: {
        id: string;
        fileName: string;
        userId: string;
        rows: { rowNo: number; raw: unknown; parsed: unknown; errors: unknown }[];
      },
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const valid = imp.rows.filter((r) => r.parsed !== null).length;
      const payload = JSON.stringify(
        imp.rows.map((r) => ({ row_no: r.rowNo, raw: r.raw, parsed: r.parsed, errors: r.errors })),
      );
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        im AS (
          INSERT INTO lms.question_imports (id, tenant_id, course_id, created_by, file_name, total_rows, valid_rows)
          SELECT ${imp.id}::uuid, ${a.tenantId}::uuid, acc.id, ${imp.userId}::uuid, ${imp.fileName}, ${imp.rows.length}, ${valid}
            FROM acc WHERE acc.visible AND acc.allowed
          RETURNING *),
        rw AS (
          INSERT INTO lms.question_import_rows (tenant_id, import_id, row_no, raw, parsed, errors)
          SELECT ${a.tenantId}::uuid, im.id, x.row_no, x.raw, x.parsed, x.errors
            FROM im, jsonb_to_recordset(${payload}::jsonb) AS x(row_no int, raw jsonb, parsed jsonb, errors jsonb)
          RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT to_jsonb(im) FROM im) AS row,
               (SELECT count(*) FROM rw) AS n`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async getImport(
      tx: Executor,
      a: CourseAccessSpec,
      importId: string,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(i) FROM lms.question_imports i
                 WHERE i.tenant_id = ${a.tenantId}::uuid AND i.course_id = ${a.courseId}::uuid
                   AND i.id = ${importId}::uuid AND ${ok}) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async importRows(
      tx: Executor,
      a: CourseAccessSpec,
      importId: string,
      f: { status: 'valid' | 'invalid' | null; after: number; limit: number },
    ): Promise<{ acc: CourseAccessRow | null; found: boolean; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        imp AS (SELECT i.id FROM lms.question_imports i WHERE i.tenant_id = ${a.tenantId}::uuid
                   AND i.course_id = ${a.courseId}::uuid AND i.id = ${importId}::uuid AND ${ok})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM imp) AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object('rowNo', r.row_no, 'valid', r.parsed IS NOT NULL,
                           'errors', r.errors, 'question', coalesce(r.raw ->> 'question', ''), 'type', coalesce(r.raw ->> 'type', ''))
                           ORDER BY r.row_no)
                           FROM (SELECT * FROM lms.question_import_rows r
                                  WHERE r.tenant_id = ${a.tenantId}::uuid AND r.import_id = ${importId}::uuid
                                    AND r.row_no > ${f.after} AND EXISTS (SELECT 1 FROM imp)
                                    ${f.status === 'valid' ? sql`AND r.parsed IS NOT NULL` : f.status === 'invalid' ? sql`AND r.parsed IS NULL` : sql``}
                                  ORDER BY r.row_no LIMIT ${f.limit + 1}) r), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, rows: (r?.rows as Row[]) ?? [] };
    },

    /**
     * Creates a question per valid staged row (set based), removes the staging rows, marks the import applied: ONE
     * statement. `blocked`: 'state' (not staged any more) or 'invalid' (some rows are invalid and skipInvalid is off).
     */
    async applyImport(
      tx: Executor,
      a: CourseAccessSpec,
      importId: string,
      userId: string,
      skipInvalid: boolean,
    ): Promise<{
      acc: CourseAccessRow | null;
      row: Row | null;
      blocked: 'state' | 'invalid' | null;
    }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        imp AS (SELECT i.* FROM lms.question_imports i
                 WHERE i.tenant_id = ${a.tenantId}::uuid AND i.course_id = ${a.courseId}::uuid AND i.id = ${importId}::uuid
                   AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed) FOR UPDATE),
        go AS (SELECT imp.id FROM imp WHERE imp.status = 'staged' AND (${skipInvalid} OR imp.valid_rows = imp.total_rows)),
        todo AS MATERIALIZED (
          SELECT r.row_no, lms.uuid_v7() AS qid, lms.uuid_v7() AS vid, r.parsed
            FROM go JOIN lms.question_import_rows r ON r.tenant_id = ${a.tenantId}::uuid AND r.import_id = go.id
           WHERE r.parsed IS NOT NULL ORDER BY r.row_no),
        qn AS (
          INSERT INTO lms.questions (id, tenant_id, course_id, current_version_id, created_by)
          SELECT qid, ${a.tenantId}::uuid, ${a.courseId}::uuid, vid, ${userId}::uuid FROM todo RETURNING id),
        ver AS (
          INSERT INTO lms.question_versions (id, tenant_id, question_id, version, type, difficulty, presentation, answer_key, created_by)
          SELECT vid, ${a.tenantId}::uuid, qid, 1, parsed ->> 'type', parsed ->> 'difficulty', parsed -> 'presentation',
                 parsed -> 'answerKey', ${userId}::uuid FROM todo RETURNING 1),
        tg AS (
          INSERT INTO lms.question_tags (tenant_id, course_id, question_id, tag)
          SELECT ${a.tenantId}::uuid, ${a.courseId}::uuid, todo.qid, t.tag
            FROM todo, jsonb_array_elements_text(todo.parsed -> 'tags') t(tag) ON CONFLICT DO NOTHING RETURNING 1),
        dl AS (
          DELETE FROM lms.question_import_rows r USING go
           WHERE r.tenant_id = ${a.tenantId}::uuid AND r.import_id = go.id RETURNING 1),
        up AS (
          UPDATE lms.question_imports i SET status = 'applied', created_count = (SELECT count(*) FROM todo)
            FROM go WHERE i.tenant_id = ${a.tenantId}::uuid AND i.id = go.id RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(imp) || CASE WHEN EXISTS (SELECT 1 FROM go)
                  THEN jsonb_build_object('status', 'applied', 'created_count', (SELECT count(*) FROM todo)) ELSE '{}'::jsonb END
                  FROM imp) AS row,
               (SELECT CASE WHEN imp.status <> 'staged' THEN 'state' WHEN NOT EXISTS (SELECT 1 FROM go) THEN 'invalid' END FROM imp) AS blocked,
               (SELECT count(*) FROM qn) + (SELECT count(*) FROM ver) + (SELECT count(*) FROM tg) + (SELECT count(*) FROM dl) + (SELECT count(*) FROM up) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        row: (r?.row as Row | null) ?? null,
        blocked: (r?.blocked as 'state' | 'invalid' | null) ?? null,
      };
    },

    /** Worker: removes staged imports nobody confirmed (their rows cascade). */
    async purgeImports(conn: Executor, hours: number): Promise<number> {
      const res = await conn.execute(
        sql`SELECT lms.question_imports_purge(make_interval(hours => ${hours}::integer)) AS n`,
      );
      return Number(res.rows[0]?.n ?? 0);
    },

    async cancelImport(
      tx: Executor,
      a: CourseAccessSpec,
      importId: string,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null; wasStaged: boolean }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        imp AS (SELECT i.* FROM lms.question_imports i
                 WHERE i.tenant_id = ${a.tenantId}::uuid AND i.course_id = ${a.courseId}::uuid AND i.id = ${importId}::uuid
                   AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed) FOR UPDATE),
        go AS (SELECT imp.id FROM imp WHERE imp.status = 'staged'),
        dl AS (DELETE FROM lms.question_import_rows r USING go
                WHERE r.tenant_id = ${a.tenantId}::uuid AND r.import_id = go.id RETURNING 1),
        up AS (UPDATE lms.question_imports i SET status = 'cancelled' FROM go
                WHERE i.tenant_id = ${a.tenantId}::uuid AND i.id = go.id RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(imp) || CASE WHEN EXISTS (SELECT 1 FROM go) THEN jsonb_build_object('status', 'cancelled') ELSE '{}'::jsonb END FROM imp) AS row,
               EXISTS (SELECT 1 FROM go) AS was_staged,
               (SELECT count(*) FROM dl) + (SELECT count(*) FROM up) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        row: (r?.row as Row | null) ?? null,
        wasStaged: r?.was_staged === true,
      };
    },
  };
}
export type QuestionsRepository = ReturnType<typeof createQuestionsRepository>;

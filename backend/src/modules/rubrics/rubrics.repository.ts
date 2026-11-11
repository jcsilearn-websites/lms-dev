import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type CourseAccessRow, type CourseAccessSpec, courseAccessCte } from '../courses';

// SQL only. Each function is ONE statement: the access CTE (is the caller allowed in this course) travels in the same
// statement as the work, so there is no check-then-act gap.
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): CourseAccessRow | null => (v as CourseAccessRow | null) ?? null;
const ok = sql`EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)`;
const T = (a: CourseAccessSpec) => sql`${a.tenantId}::uuid`;

export interface NewRubric {
  title: string;
  criteria: unknown;
  maxPoints: number;
  userId: string;
}

const usedBy = (r: SQL): SQL => sql`(SELECT count(*) FROM lms.assignments x
   WHERE x.tenant_id = ${r}.tenant_id AND x.rubric_id = ${r}.id)::integer`;

const detailJson = (r: SQL, v: SQL): SQL => sql`jsonb_build_object(
  'id', ${r}.id, 'courseId', ${r}.course_id, 'title', ${r}.title, 'versionId', ${v}.id,
  'versionNo', ${v}.version_no, 'maxPoints', ${v}.max_points, 'criteria', ${v}.criteria,
  'archived', ${r}.archived_at IS NOT NULL, 'usedBy', ${usedBy(r)},
  'createdAt', ${r}.created_at, 'updatedAt', ${r}.updated_at)`;

export function createRubricsRepository() {
  return {
    async list(
      tx: Executor,
      a: CourseAccessSpec,
      f: { includeArchived: boolean; limit: number; after: string | null },
    ): Promise<{ acc: CourseAccessRow | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        page AS (
          SELECT r.id, jsonb_build_object(
                   'id', r.id, 'title', r.title, 'versionNo', v.version_no, 'maxPoints', v.max_points,
                   'criteriaCount', jsonb_array_length(v.criteria), 'archived', r.archived_at IS NOT NULL,
                   'usedBy', ${usedBy(sql`r`)}, 'updatedAt', r.updated_at) AS j
            FROM lms.rubrics r
            JOIN lms.rubric_versions v ON v.tenant_id = r.tenant_id AND v.id = r.current_version_id
           WHERE r.tenant_id = ${T(a)} AND r.course_id = ${a.courseId}::uuid AND ${ok}
             AND (${f.includeArchived}::boolean OR r.archived_at IS NULL)
             AND (${f.after}::uuid IS NULL OR r.id < ${f.after}::uuid)
           ORDER BY r.id DESC
           LIMIT ${f.limit + 1})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(j ORDER BY id DESC) FROM page), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[]) ?? [] };
    },

    async get(
      tx: Executor,
      a: CourseAccessSpec,
      rubricId: string,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${detailJson(sql`r`, sql`v`)}
                  FROM lms.rubrics r
                  JOIN lms.rubric_versions v ON v.tenant_id = r.tenant_id AND v.id = r.current_version_id
                 WHERE r.tenant_id = ${T(a)} AND r.course_id = ${a.courseId}::uuid AND r.id = ${rubricId}::uuid
                   AND ${ok}) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async create(
      tx: Executor,
      a: CourseAccessSpec,
      ids: { rubricId: string; versionId: string },
      n: NewRubric,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        rb AS (
          INSERT INTO lms.rubrics (id, tenant_id, course_id, title, current_version_id, created_by)
          SELECT ${ids.rubricId}::uuid, ${T(a)}, acc.id, ${n.title}, ${ids.versionId}::uuid, ${n.userId}::uuid
            FROM acc WHERE acc.visible AND acc.allowed
          RETURNING *),
        ver AS (
          INSERT INTO lms.rubric_versions (id, tenant_id, rubric_id, version_no, criteria, max_points, created_by)
          SELECT ${ids.versionId}::uuid, ${T(a)}, rb.id, 1, ${JSON.stringify(n.criteria)}::jsonb,
                 ${n.maxPoints}::numeric, ${n.userId}::uuid
            FROM rb
          RETURNING *)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${detailJson(sql`rb`, sql`ver`)} FROM rb, ver) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    /** A new version; the rubric row is locked so two simultaneous edits get consecutive numbers. */
    async addVersion(
      tx: Executor,
      a: CourseAccessSpec,
      rubricId: string,
      versionId: string,
      n: NewRubric,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        cur AS (
          SELECT r.id, coalesce((SELECT max(v.version_no) FROM lms.rubric_versions v
                                  WHERE v.tenant_id = r.tenant_id AND v.rubric_id = r.id), 0) AS n
            FROM lms.rubrics r
           WHERE r.tenant_id = ${T(a)} AND r.course_id = ${a.courseId}::uuid AND r.id = ${rubricId}::uuid AND ${ok}
             FOR UPDATE),
        ver AS (
          INSERT INTO lms.rubric_versions (id, tenant_id, rubric_id, version_no, criteria, max_points, created_by)
          SELECT ${versionId}::uuid, ${T(a)}, cur.id, cur.n + 1, ${JSON.stringify(n.criteria)}::jsonb,
                 ${n.maxPoints}::numeric, ${n.userId}::uuid
            FROM cur
          RETURNING *),
        upd AS (
          UPDATE lms.rubrics r SET title = ${n.title}, current_version_id = ver.id, updated_at = now()
            FROM ver WHERE r.tenant_id = ${T(a)} AND r.id = ${rubricId}::uuid
          RETURNING r.*)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${detailJson(sql`upd`, sql`ver`)} FROM upd, ver) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async setArchived(
      tx: Executor,
      a: CourseAccessSpec,
      rubricId: string,
      archived: boolean,
    ): Promise<{ acc: CourseAccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${courseAccessCte(a)},
        upd AS (
          UPDATE lms.rubrics r
             SET archived_at = CASE WHEN ${archived}::boolean THEN coalesce(r.archived_at, now()) END, updated_at = now()
           WHERE r.tenant_id = ${T(a)} AND r.course_id = ${a.courseId}::uuid AND r.id = ${rubricId}::uuid AND ${ok}
          RETURNING r.*)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT ${detailJson(sql`upd`, sql`v`)}
                  FROM upd JOIN lms.rubric_versions v ON v.tenant_id = upd.tenant_id AND v.id = upd.current_version_id) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },
  };
}
export type RubricsRepository = ReturnType<typeof createRubricsRepository>;

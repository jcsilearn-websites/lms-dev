import { type SQL, sql } from 'drizzle-orm';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. Instructor operations are ONE statement each (the access CTE travels with the work); learner operations are
// ONE call of a SECURITY DEFINER function (migration 0033) on an autocommit connection.
//
// Blind grading is decided HERE, in SQL: while an assignment is graded blind, the name, e-mail and register number of a
// learner are `NULL` in the rows that leave the database (until that learner's grade is released), so no layer above can
// leak them by mistake. The queue is never ordered by anything that identifies a learner (name, e-mail, register number,
// participant id): only by the random anonymous code or by the submission time.
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const ok = sql`EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)`;
const T = (a: AccessSpec) => sql`${a.tenantId}::uuid`;
const ITEM = sql`(SELECT id FROM it)`;

/** The assignment item of the offering the caller may use (`it`: at most one row). */
const itemCte = (a: AccessSpec, itemId: string): SQL => sql`it AS (
  SELECT i.id, i.title, i.published FROM lms.content_items i
   WHERE i.tenant_id = ${a.tenantId}::uuid AND i.offering_id = ${a.offeringId}::uuid AND i.id = ${itemId}::uuid
     AND i.kind = 'assignment' AND i.deleted_at IS NULL AND ${ok})`;

const settingsJson = (s: SQL): SQL => sql`jsonb_build_object(
  'instructions', ${s}.instructions, 'opensAt', ${s}.opens_at, 'dueAt', ${s}.due_at, 'latePolicy', ${s}.late_policy,
  'lateCutoffAt', ${s}.late_cutoff_at, 'penaltyKind', ${s}.penalty_kind, 'penaltyValue', ${s}.penalty_value,
  'penaltyCap', ${s}.penalty_cap, 'maxPoints', ${s}.max_points, 'passingScore', ${s}.passing_score,
  'allowFile', ${s}.allow_file, 'allowText', ${s}.allow_text, 'allowLink', ${s}.allow_link, 'maxFiles', ${s}.max_files,
  'maxFileMb', ${s}.max_file_mb, 'resubmissionAllowed', ${s}.resubmission_allowed,
  'anonymousGrading', ${s}.anonymous_grading, 'releaseMode', ${s}.release_mode)`;

/** the settings without the (large) instructions: what the audit entry of a change carries */
const settingsAuditJson = (s: SQL): SQL => sql`(${settingsJson(s)} - 'instructions')`;

const fileJson = (
  f: SQL,
): SQL => sql`jsonb_build_object('fileId', ${f}.id, 'name', ${f}.original_name,
  'size', ${f}.size_bytes, 'contentType', ${f}.content_type)`;

export interface SettingsPatch {
  instructions?: unknown;
  opensAt?: string | null;
  dueAt?: string | null;
  latePolicy?: string;
  lateCutoffAt?: string | null;
  penaltyKind?: string;
  penaltyValue?: number;
  penaltyCap?: number;
  maxPoints?: number;
  passingScore?: number | null;
  allowFile?: boolean;
  allowText?: boolean;
  allowLink?: boolean;
  maxFiles?: number;
  maxFileMb?: number;
  resubmissionAllowed?: boolean;
  anonymousGrading?: boolean;
  releaseMode?: string;
}

/** `default`: by name, or by the anonymous code while the assignment is graded blind */
export type QueueSort = 'time' | 'code' | 'name' | 'default';

export interface QueueQuery {
  status: string | null;
  section: string | null;
  sort: QueueSort;
  limit: number;
  /** the sort key and the learner key of the last row of the previous page */
  after: { sk: string; key: string } | null;
}

export interface GradeWrite {
  learnerKey: string;
  submissionId: string;
  /** null = not given */
  selection: Record<string, { levelId: string; comment?: string | undefined }> | null;
  rawScore: number | null;
  overrideReason: string | null;
  feedback: unknown;
  feedbackGiven: boolean;
  feedbackFileIds: string[] | null;
  userId: string;
}

/**
 * The class of the assignment, one row per active learner: identity (NULL while blind), the latest version, the grade and
 * the derived status. Every step is a unique-key lookup per learner: the statement must not depend on planner estimates (a
 * freshly loaded college has no statistics, see CLAUDE.md "Planner lesson").
 */
function classCtes(
  a: AccessSpec,
  itemId: string,
  f: { section?: string | null; learnerKey?: string | null },
): SQL {
  const t = T(a);
  return sql`${itemCte(a, itemId)},
    s AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${t} AND s.item_id = ${ITEM}),
    parts AS MATERIALIZED (
      SELECT p.id AS pid, al.learner_key, al.anon_code, u.display_name, u.email, mp.register_number,
             sec.code AS section_name
        FROM lms.course_participants p
        JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
        JOIN lms.users u ON u.id = tm.user_id
        LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
        LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id
        LEFT JOIN lms.assignment_learners al ON al.tenant_id = p.tenant_id AND al.assignment_item_id = ${ITEM}
                                            AND al.participant_id = p.id
       WHERE p.tenant_id = ${t} AND p.offering_id = ${a.offeringId}::uuid AND p.participation = 'learner'
         AND p.status = 'active' AND EXISTS (SELECT 1 FROM it)
         ${f.section ? sql`AND mp.section_id = ${f.section}::uuid` : sql``}
         ${f.learnerKey ? sql`AND al.learner_key = ${f.learnerKey}::uuid` : sql``}),
    q AS (
      SELECT pa.pid, pa.learner_key, pa.anon_code, sub.id AS sub_id, sub.version_no, sub.submitted_at, sub.late_seconds,
             gr.submission_id AS g_sub, gr.raw_score, gr.released_at, gr.penalty_waived,
             (gr.submission_id IS NOT NULL AND gr.submission_id <> sub.id) AS outdated,
             (gr.submission_id IS NOT NULL AND (gr.released_at IS NOT NULL OR s.release_mode = 'immediate')) AS grade_visible,
             -- the identity leaves the database only when the assignment is not blind, or this grade was released
             (s.anonymous_grading AND gr.released_at IS NULL) AS hidden,
             pa.display_name, pa.email, pa.register_number, pa.section_name,
             CASE WHEN gr.submission_id IS NULL THEN NULL
                  WHEN gr.penalty_waived THEN 0::numeric
                  WHEN gr.penalty_percent IS NOT NULL THEN gr.penalty_percent
                  ELSE lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap,
                         coalesce(gs.late_seconds, 0)) END AS pct,
             s.max_points
        FROM parts pa
        CROSS JOIN s
        LEFT JOIN LATERAL (SELECT x.id, x.version_no, x.submitted_at, x.late_seconds FROM lms.submissions x
                            WHERE x.tenant_id = ${t} AND x.assignment_item_id = ${ITEM} AND x.participant_id = pa.pid
                            ORDER BY x.version_no DESC LIMIT 1) sub ON true
        LEFT JOIN lms.assignment_grades gr ON gr.tenant_id = ${t} AND gr.assignment_item_id = ${ITEM}
                                          AND gr.participant_id = pa.pid
        LEFT JOIN LATERAL (SELECT x.late_seconds FROM lms.submissions x
                            WHERE x.tenant_id = ${t} AND x.id = gr.submission_id OFFSET 0) gs ON true),
    r AS (
      SELECT q.*,
             CASE WHEN q.sub_id IS NULL THEN 'not_submitted'
                  WHEN q.g_sub = q.sub_id AND q.grade_visible AND q.released_at IS NOT NULL THEN 'released'
                  WHEN q.g_sub = q.sub_id THEN 'graded'
                  WHEN q.late_seconds > 0 THEN 'late'
                  ELSE 'submitted' END AS status,
             CASE WHEN q.g_sub IS NULL THEN NULL
                  ELSE lms.assignment_final_points(q.raw_score, q.max_points, q.pct) END AS final_score
        FROM q)`;
}

const rowJson = (r: SQL): SQL => sql`jsonb_build_object(
  'learnerKey', ${r}.learner_key, 'anonCode', ${r}.anon_code,
  'name', CASE WHEN ${r}.hidden THEN NULL ELSE ${r}.display_name END,
  'email', CASE WHEN ${r}.hidden THEN NULL ELSE ${r}.email END,
  'registerNumber', CASE WHEN ${r}.hidden THEN NULL ELSE ${r}.register_number END,
  'sectionName', ${r}.section_name, 'status', ${r}.status, 'versionNo', ${r}.version_no,
  'submittedAt', ${r}.submitted_at, 'lateSeconds', coalesce(${r}.late_seconds, 0), 'gradeOutdated', coalesce(${r}.outdated, false),
  'rawScore', ${r}.raw_score, 'finalScore', ${r}.final_score)`;

/** a version of a learner with its files, newest first */
const versionsJson = (t: SQL, itemId: SQL, pid: SQL, rate: SQL): SQL => sql`coalesce((
  SELECT jsonb_agg(jsonb_build_object(
           'id', sv.id, 'versionNo', sv.version_no, 'submittedAt', sv.submitted_at, 'lateSeconds', sv.late_seconds,
           'onGrace', sv.on_grace, 'text', sv.text_body, 'link', sv.link_url, 'penaltyPercent', ${rate},
           'files', coalesce((SELECT jsonb_agg(${fileJson(sql`f`)} ORDER BY sf.position)
                                FROM lms.submission_files sf
                                JOIN lms.files f ON f.tenant_id = sf.tenant_id AND f.id = sf.file_id
                               WHERE sf.tenant_id = sv.tenant_id AND sf.submission_id = sv.id), '[]'::jsonb))
         ORDER BY sv.version_no DESC)
    FROM (SELECT * FROM lms.submissions x
           WHERE x.tenant_id = ${t} AND x.assignment_item_id = ${itemId} AND x.participant_id = ${pid}
           ORDER BY x.version_no DESC LIMIT 20) sv), '[]'::jsonb)`;

export function createAssignmentsRepository() {
  return {
    // ================================================================ configuration (instructors)
    async getConfig(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT jsonb_build_object(
                  'itemId', it.id, 'courseId', s.course_id, 'title', it.title, 'published', it.published,
                  'settings', ${settingsJson(sql`s`)},
                  'attachments', coalesce((SELECT jsonb_agg(${fileJson(sql`f`)} ORDER BY at.position)
                                             FROM lms.assignment_attachments at
                                             JOIN lms.files f ON f.tenant_id = at.tenant_id AND f.id = at.file_id
                                            WHERE at.tenant_id = s.tenant_id AND at.assignment_item_id = s.item_id), '[]'::jsonb),
                  'rubric', (SELECT jsonb_build_object('rubricId', rb.id, 'versionId', rv.id, 'title', rb.title,
                                                       'versionNo', rv.version_no, 'maxPoints', rv.max_points,
                                                       'newerVersionAvailable', rb.current_version_id <> rv.id)
                               FROM lms.rubrics rb
                               JOIN lms.rubric_versions rv ON rv.tenant_id = rb.tenant_id AND rv.id = s.rubric_version_id
                              WHERE rb.tenant_id = s.tenant_id AND rb.id = s.rubric_id),
                  'submissionCount', (SELECT count(DISTINCT x.participant_id) FROM lms.submissions x
                                       WHERE x.tenant_id = s.tenant_id AND x.assignment_item_id = s.item_id),
                  'gradedCount', (SELECT count(*) FROM lms.assignment_grades g
                                   WHERE g.tenant_id = s.tenant_id AND g.assignment_item_id = s.item_id))
                  FROM it, s) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    /** The audit entry carries the settings before and after (without the instructions text). */
    async updateSettings(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      p: SettingsPatch,
    ): Promise<{ acc: AccessRow | null; settings: Row | null }> {
      const set: SQL[] = [];
      const col: [keyof SettingsPatch, string, string][] = [
        ['opensAt', 'opens_at', 'timestamptz'],
        ['dueAt', 'due_at', 'timestamptz'],
        ['latePolicy', 'late_policy', 'text'],
        ['lateCutoffAt', 'late_cutoff_at', 'timestamptz'],
        ['penaltyKind', 'penalty_kind', 'text'],
        ['penaltyValue', 'penalty_value', 'numeric'],
        ['penaltyCap', 'penalty_cap', 'numeric'],
        ['maxPoints', 'max_points', 'numeric'],
        ['passingScore', 'passing_score', 'numeric'],
        ['allowFile', 'allow_file', 'boolean'],
        ['allowText', 'allow_text', 'boolean'],
        ['allowLink', 'allow_link', 'boolean'],
        ['maxFiles', 'max_files', 'smallint'],
        ['maxFileMb', 'max_file_mb', 'smallint'],
        ['resubmissionAllowed', 'resubmission_allowed', 'boolean'],
        ['anonymousGrading', 'anonymous_grading', 'boolean'],
        ['releaseMode', 'release_mode', 'text'],
      ];
      for (const [k, c, type] of col) {
        if (p[k] !== undefined) set.push(sql`${sql.raw(c)} = ${p[k] as never}::${sql.raw(type)}`);
      }
      if (p.instructions !== undefined)
        set.push(
          sql`instructions = ${p.instructions === null ? null : JSON.stringify(p.instructions)}::jsonb`,
        );
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        old AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM}),
        upd AS (
          UPDATE lms.assignments s SET ${sql.join(set, sql`, `)}, updated_at = now() FROM it
           WHERE s.tenant_id = ${T(a)} AND s.item_id = it.id RETURNING s.*),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.settings_changed',
            targetType: 'assignment',
          },
          {
            from: sql`upd x`,
            targetId: sql`x.item_id`,
            metadata: sql`jsonb_build_object('before', (SELECT ${settingsAuditJson(sql`old`)} FROM old),
                           'after', ${settingsAuditJson(sql`x`)})`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ${settingsJson(sql`upd`)} FROM upd) AS settings,
               (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), settings: (r?.settings as Row | null) ?? null };
    },

    /** Replaces the attachments. Files must be READY and uploaded by the caller (or already attached here). */
    async replaceAttachments(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      fileIds: string[],
    ): Promise<{ acc: AccessRow | null; found: boolean; filesOk: boolean; attachments: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        fl AS (
          SELECT f.id FROM lms.files f
           WHERE f.tenant_id = ${T(a)} AND f.id = ANY(${pgArray(fileIds)}::uuid[]) AND f.status = 'ready'
             AND (f.created_by = ${a.userId}::uuid
                  OR EXISTS (SELECT 1 FROM lms.assignment_attachments x
                              WHERE x.tenant_id = f.tenant_id AND x.file_id = f.id AND x.assignment_item_id = ${ITEM}))),
        files_ok AS (SELECT (SELECT count(*) FROM fl) = ${fileIds.length} AS ok),
        del AS (
          DELETE FROM lms.assignment_attachments x
           USING it, files_ok
           WHERE x.tenant_id = ${T(a)} AND x.assignment_item_id = it.id AND files_ok.ok
             AND x.file_id <> ALL(${pgArray(fileIds)}::uuid[])
          RETURNING x.file_id),
        unref AS (
          UPDATE lms.files f SET last_unreferenced_at = now() FROM del
           WHERE f.tenant_id = ${T(a)} AND f.id = del.file_id RETURNING 1),
        ins AS (
          INSERT INTO lms.assignment_attachments (tenant_id, assignment_item_id, file_id, position)
          SELECT ${T(a)}, it.id, o.file_id, o.ord::smallint
            FROM it, files_ok, unnest(${pgArray(fileIds)}::uuid[]) WITH ORDINALITY AS o (file_id, ord)
           WHERE files_ok.ok
          ON CONFLICT (tenant_id, assignment_item_id, file_id) DO UPDATE SET position = EXCLUDED.position
          RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT ok FROM files_ok) AS files_ok,
               (SELECT count(*) FROM ins) + (SELECT count(*) FROM unref) AS n,
               coalesce((SELECT jsonb_agg(${fileJson(sql`f`)} ORDER BY o.ord)
                           FROM unnest(${pgArray(fileIds)}::uuid[]) WITH ORDINALITY AS o (file_id, ord)
                           JOIN lms.files f ON f.tenant_id = ${T(a)} AND f.id = o.file_id
                          WHERE (SELECT ok FROM files_ok)), '[]'::jsonb) AS attachments`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        filesOk: r?.files_ok === true,
        attachments: (r?.attachments as Row[]) ?? [],
      };
    },

    /**
     * Attaches a rubric of the SAME course (its CURRENT version is pinned) or removes it (null). Once learners are graded
     * only the same rubric (a newer version of it) may be attached again.
     */
    async attachRubric(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      rubricId: string | null,
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      rubricFound: boolean;
      archived: boolean;
      blocked: boolean;
      done: boolean;
    }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM}),
        rb AS (
          SELECT r.id, r.current_version_id, r.archived_at FROM lms.rubrics r, s
           WHERE r.tenant_id = ${T(a)} AND r.course_id = s.course_id AND r.id = ${rubricId}::uuid),
        graded AS (SELECT EXISTS (SELECT 1 FROM lms.assignment_grades g
                                   WHERE g.tenant_id = ${T(a)} AND g.assignment_item_id = ${ITEM}) AS has_grades),
        upd AS (
          UPDATE lms.assignments x
             SET rubric_id = rb.id, rubric_version_id = rb.current_version_id, updated_at = now()
            FROM it, s, rb, graded
           WHERE ${rubricId === null ? sql`false` : sql`true`}
             AND x.tenant_id = ${T(a)} AND x.item_id = it.id AND rb.archived_at IS NULL
             AND (NOT graded.has_grades OR s.rubric_id = rb.id)
          RETURNING 1),
        clr AS (
          UPDATE lms.assignments x SET rubric_id = NULL, rubric_version_id = NULL, updated_at = now()
            FROM it, graded
           WHERE ${rubricId === null ? sql`true` : sql`false`}
             AND x.tenant_id = ${T(a)} AND x.item_id = it.id AND NOT graded.has_grades
          RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               EXISTS (SELECT 1 FROM rb) AS rubric_found,
               coalesce((SELECT archived_at IS NOT NULL FROM rb), false) AS archived,
               (SELECT has_grades FROM graded) AS blocked,
               (SELECT count(*) FROM upd) + (SELECT count(*) FROM clr) > 0 AS done`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        rubricFound: r?.rubric_found === true,
        archived: r?.archived === true,
        blocked: r?.blocked === true,
        done: r?.done === true,
      };
    },

    // ================================================================ extensions (sensitive)
    async listExtensions(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                           'participantId', x.participant_id, 'learnerName', u.display_name, 'learnerEmail', u.email,
                           'extendedDueAt', x.extended_due_at, 'reason', x.reason, 'updatedAt', x.updated_at)
                           ORDER BY x.extended_due_at, x.participant_id)
                           FROM lms.assignment_extensions x
                           JOIN lms.course_participants cp ON cp.tenant_id = x.tenant_id AND cp.id = x.participant_id
                           JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                           JOIN lms.users u ON u.id = tm.user_id
                          WHERE x.tenant_id = ${T(a)} AND x.assignment_item_id = ${ITEM}), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, rows: (r?.rows as Row[]) ?? [] };
    },

    /** The AUDIT entry carries the dates, NEVER the reason (it can reveal a health condition). */
    async setExtension(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      participantId: string,
      v: { extendedDueAt: string; reason: string | null },
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      participantOk: boolean;
      dateOk: boolean;
      row: Row | null;
    }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.due_at FROM lms.assignments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM}),
        date_ok AS (SELECT (SELECT due_at IS NOT NULL AND ${v.extendedDueAt}::timestamptz > due_at FROM s) AS ok),
        part AS (SELECT p.id FROM lms.course_participants p
                  WHERE p.tenant_id = ${T(a)} AND p.offering_id = ${a.offeringId}::uuid AND p.id = ${participantId}::uuid
                    AND p.participation = 'learner' AND p.status = 'active'),
        old AS (SELECT x.extended_due_at FROM lms.assignment_extensions x
                 WHERE x.tenant_id = ${T(a)} AND x.assignment_item_id = ${ITEM} AND x.participant_id = ${participantId}::uuid),
        up AS (
          INSERT INTO lms.assignment_extensions (tenant_id, assignment_item_id, participant_id, extended_due_at, reason, set_by)
          SELECT ${T(a)}, it.id, part.id, ${v.extendedDueAt}::timestamptz, ${v.reason}, ${a.userId}::uuid
            FROM it, part, date_ok WHERE date_ok.ok
          ON CONFLICT (tenant_id, assignment_item_id, participant_id) DO UPDATE SET
            extended_due_at = EXCLUDED.extended_due_at, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by,
            updated_at = now()
          RETURNING *),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.extension_set',
            targetType: 'assignment',
          },
          {
            from: sql`(SELECT up.assignment_item_id, up.participant_id, up.extended_due_at,
                              (SELECT o.extended_due_at FROM old o) AS before FROM up) x`,
            targetId: sql`x.assignment_item_id`,
            // dates only: the reason is private and stays out of the audit log
            metadata: sql`jsonb_build_object('participantId', x.participant_id,
                           'before', jsonb_build_object('extendedDueAt', x.before),
                           'after', jsonb_build_object('extendedDueAt', x.extended_due_at))`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               EXISTS (SELECT 1 FROM part) AS part_ok, coalesce((SELECT ok FROM date_ok), false) AS date_ok,
               (SELECT count(*) FROM au) AS n,
               (SELECT jsonb_build_object('participantId', up.participant_id, 'learnerName', u.display_name,
                         'learnerEmail', u.email, 'extendedDueAt', up.extended_due_at, 'reason', up.reason,
                         'updatedAt', up.updated_at)
                  FROM up
                  JOIN lms.course_participants cp ON cp.tenant_id = ${T(a)} AND cp.id = up.participant_id
                  JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  JOIN lms.users u ON u.id = tm.user_id) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        participantOk: r?.part_ok === true,
        dateOk: r?.date_ok === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    async removeExtension(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      participantId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; removed: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        del AS (
          DELETE FROM lms.assignment_extensions x USING it
           WHERE x.tenant_id = ${T(a)} AND x.assignment_item_id = it.id AND x.participant_id = ${participantId}::uuid
          RETURNING x.assignment_item_id, x.participant_id, x.extended_due_at),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.extension_removed',
            targetType: 'assignment',
          },
          {
            from: sql`del x`,
            targetId: sql`x.assignment_item_id`,
            metadata: sql`jsonb_build_object('participantId', x.participant_id,
                           'before', jsonb_build_object('extendedDueAt', x.extended_due_at))`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT count(*) FROM del) > 0 AS removed, (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, removed: r?.removed === true };
    },

    // ================================================================ the learner (definer functions)
    async me(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; itemId: string; grace: number },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.assignment_me(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.grace}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async uploadBegin(
      conn: Executor,
      p: {
        tenantId: string;
        userId: string;
        offeringId: string;
        itemId: string;
        fileId: string;
        storageKey: string;
        name: string;
        contentType: string;
        size: number;
        grace: number;
        arrival: { at: Date; maxAgeSeconds: number } | null;
      },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.assignment_upload_begin(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.fileId}::uuid, ${p.storageKey}, ${p.name}, ${p.contentType},
        ${p.size}::bigint, ${p.grace}::integer, ${p.arrival?.at.toISOString() ?? null}::timestamptz,
        ${p.arrival?.maxAgeSeconds ?? 30}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async submit(
      conn: Executor,
      p: {
        tenantId: string;
        userId: string;
        offeringId: string;
        itemId: string;
        requestKey: string;
        text: string | null;
        link: string | null;
        fileIds: string[];
        confirmLate: boolean;
        grace: number;
        arrival: { at: Date; maxAgeSeconds: number } | null;
      },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.assignment_submit(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.requestKey}::uuid, ${p.text}, ${p.link},
        ${pgArray(p.fileIds)}::uuid[], ${p.confirmLate}::boolean, ${p.grace}::integer,
        ${p.arrival?.at.toISOString() ?? null}::timestamptz, ${p.arrival?.maxAgeSeconds ?? 30}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    /** The row of the function: `result` is the gate's verdict, 'ok', or 'not_found'. */
    async fileAccess(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; itemId: string; fileId: string },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT * FROM lms.assignment_file_access(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.fileId}::uuid)`);
      return (res.rows[0] as Row | undefined) ?? { result: 'not_found' };
    },
    async uploadCheck(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; itemId: string; fileId: string },
    ): Promise<string> {
      const res =
        await conn.execute(sql`SELECT lms.assignment_upload_check(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.fileId}::uuid) AS r`);
      return String(res.rows[0]?.r ?? 'not_found');
    },

    // ================================================================ grading
    /** Creates the random key and anonymous code of every active learner who has none (first open of the queue). */
    async ensureLearners(tx: Executor, a: AccessSpec, itemId: string): Promise<number> {
      // gen_random_uuid() on purpose: this key is an opaque token that must not be time-ordered (a time-ordered id would
      // order blind learners by the order they were created in); the anonymous code is random as well
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        ins AS (
          INSERT INTO lms.assignment_learners (tenant_id, assignment_item_id, participant_id, learner_key, anon_code)
          SELECT ${T(a)}, it.id, p.id, gen_random_uuid(), lms.anon_code()
            FROM it
            JOIN lms.course_participants p ON p.tenant_id = ${T(a)} AND p.offering_id = ${a.offeringId}::uuid
                                          AND p.participation = 'learner' AND p.status = 'active'
           ORDER BY random()
          ON CONFLICT DO NOTHING
          RETURNING 1)
        SELECT count(*)::integer AS n FROM ins`);
      return Number(res.rows[0]?.n ?? 0);
    },

    async queue(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      q: QueueQuery,
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      blind: boolean;
      maxPoints: number | null;
      missing: number;
      rows: Row[];
    }> {
      // the sort key of a row, as text so one keyset serves every order ("C" collation: stable and portable)
      const sk: SQL =
        q.sort === 'code'
          ? sql`r.anon_code`
          : q.sort === 'name'
            ? sql`lower(r.display_name) || ' ' || r.anon_code`
            : q.sort === 'default'
              ? sql`CASE WHEN (SELECT anonymous_grading FROM s) THEN r.anon_code
                         ELSE lower(r.display_name) || ' ' || r.anon_code END`
              : sql`coalesce(to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'z')`;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${classCtes(a, itemId, { section: q.section })},
        f AS (
          SELECT r.*, (${sk}) COLLATE "C" AS sk FROM r
           WHERE r.learner_key IS NOT NULL ${q.status ? sql`AND r.status = ${q.status}` : sql``}),
        page AS (
          SELECT f.* FROM f
           WHERE ${q.after ? sql`(f.sk, f.learner_key) > (${q.after.sk} COLLATE "C", ${q.after.key}::uuid)` : sql`true`}
           ORDER BY f.sk, f.learner_key
           LIMIT ${q.limit + 1})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT anonymous_grading FROM s) AS blind, (SELECT max_points FROM s) AS max_points,
               (SELECT count(*) FROM r WHERE r.learner_key IS NULL)::integer AS missing,
               coalesce((SELECT jsonb_agg(${rowJson(sql`p`)} || jsonb_build_object('sk', p.sk) ORDER BY p.sk, p.learner_key)
                           FROM page p), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        blind: r?.blind === true,
        maxPoints: r?.max_points == null ? null : Number(r.max_points),
        missing: Number(r?.missing ?? 0),
        rows: (r?.rows as Row[]) ?? [],
      };
    },

    async summary(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${classCtes(a, itemId, {})}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT jsonb_build_object(
                  'learners', count(*), 'notSubmitted', count(*) FILTER (WHERE status = 'not_submitted'),
                  'submitted', count(*) FILTER (WHERE status = 'submitted'),
                  'late', count(*) FILTER (WHERE status = 'late'),
                  'graded', count(*) FILTER (WHERE status = 'graded'),
                  'released', count(*) FILTER (WHERE status = 'released'),
                  'blind', (SELECT anonymous_grading FROM s))
                  FROM r) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, row: (r?.row as Row | null) ?? null };
    },

    /** One learner for grading: identity (NULL while blind), every version with its files, the grade and the rubric. */
    async learner(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      learnerKey: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; row: Row | null }> {
      const t = T(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${classCtes(a, itemId, { learnerKey })}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT jsonb_build_object(
                  'learnerKey', r.learner_key, 'anonCode', r.anon_code,
                  'name', CASE WHEN r.hidden THEN NULL ELSE r.display_name END,
                  'email', CASE WHEN r.hidden THEN NULL ELSE r.email END,
                  'registerNumber', CASE WHEN r.hidden THEN NULL ELSE r.register_number END,
                  'blind', s.anonymous_grading, 'maxPoints', s.max_points, 'passingScore', s.passing_score,
                  'rubric', (SELECT jsonb_build_object('versionId', rv.id, 'title', rb.title, 'maxPoints', rv.max_points,
                                                       'criteria', rv.criteria)
                               FROM lms.rubric_versions rv JOIN lms.rubrics rb ON rb.tenant_id = rv.tenant_id AND rb.id = rv.rubric_id
                              WHERE rv.tenant_id = ${t} AND rv.id = s.rubric_version_id),
                  'submissions', ${versionsJson(
                    t,
                    ITEM,
                    sql`r.pid`,
                    sql`lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap, sv.late_seconds)`,
                  )},
                  'penaltyPercent', CASE WHEN r.sub_id IS NULL THEN 0
                                         ELSE lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap, coalesce(r.late_seconds, 0)) END,
                  'grade', (SELECT jsonb_build_object(
                              'submissionId', g.submission_id, 'rubricVersionId', g.rubric_version_id,
                              'rubricSelection', g.rubric_selection, 'rubricScore', g.rubric_score, 'rawScore', g.raw_score,
                              'overrideReason', g.override_reason, 'feedback', g.feedback,
                              'penaltyPercent', r.pct, 'penaltyPoints', round(s.max_points * r.pct / 100, 2),
                              'penaltyWaived', g.penalty_waived, 'waiveReason', g.waive_reason,
                              'finalScore', r.final_score, 'gradedAt', g.graded_at, 'releasedAt', g.released_at,
                              'feedbackFiles', coalesce((SELECT jsonb_agg(${fileJson(sql`f`)} ORDER BY ff.position)
                                                           FROM lms.assignment_feedback_files ff
                                                           JOIN lms.files f ON f.tenant_id = ff.tenant_id AND f.id = ff.file_id
                                                          WHERE ff.tenant_id = g.tenant_id AND ff.assignment_item_id = g.assignment_item_id
                                                            AND ff.participant_id = g.participant_id), '[]'::jsonb))
                              FROM lms.assignment_grades g
                             WHERE g.tenant_id = ${t} AND g.assignment_item_id = ${ITEM} AND g.participant_id = r.pid))
                  FROM r CROSS JOIN s) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, row: (r?.row as Row | null) ?? null };
    },

    /**
     * Saves a grade in ONE statement: the rubric selection is checked and summed IN SQL against the rubric version pinned on
     * the assignment, so no read has to come first. Nothing is written unless every flag is true; the flags say why not.
     */
    async grade(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      w: GradeWrite,
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      learnerOk: boolean;
      submissionOk: boolean;
      rubricOk: boolean;
      scoreGiven: boolean;
      scoreOk: boolean;
      overrideOk: boolean;
      filesOk: boolean;
      row: Row | null;
    }> {
      const t = T(a);
      const fbIds = w.feedbackFileIds ?? [];
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${t} AND s.item_id = ${ITEM}),
        part AS (
          SELECT al.participant_id AS pid FROM lms.assignment_learners al
            JOIN lms.course_participants p ON p.tenant_id = al.tenant_id AND p.id = al.participant_id
           WHERE al.tenant_id = ${t} AND al.assignment_item_id = ${ITEM} AND al.learner_key = ${w.learnerKey}::uuid
             AND p.offering_id = ${a.offeringId}::uuid AND p.participation = 'learner' AND p.status = 'active'),
        latest AS (
          SELECT x.id, x.late_seconds FROM lms.submissions x, part
           WHERE x.tenant_id = ${t} AND x.assignment_item_id = ${ITEM} AND x.participant_id = part.pid
           ORDER BY x.version_no DESC LIMIT 1),
        old AS (SELECT g.* FROM lms.assignment_grades g, part
                 WHERE g.tenant_id = ${t} AND g.assignment_item_id = ${ITEM} AND g.participant_id = part.pid),
        rv AS (SELECT v.id, v.criteria FROM lms.rubric_versions v, s WHERE v.tenant_id = ${t} AND v.id = s.rubric_version_id),
        crit AS (SELECT c ->> 'id' AS cid, c -> 'levels' AS lv FROM rv, jsonb_array_elements(rv.criteria) c),
        sel AS (SELECT e.cid, e.v FROM jsonb_each(${JSON.stringify(w.selection ?? {})}::jsonb) AS e (cid, v)),
        pick AS (
          SELECT cr.cid, l ->> 'id' AS lid, (l ->> 'points')::numeric AS pts, sel.v ->> 'comment' AS comment
            FROM crit cr
            JOIN sel ON sel.cid = cr.cid
            CROSS JOIN LATERAL jsonb_array_elements(cr.lv) l
           WHERE l ->> 'id' = sel.v ->> 'levelId'),
        calc AS (
          SELECT (SELECT rubric_id IS NOT NULL FROM s) AS has_rubric,
                 (SELECT count(*) FROM crit) AS ncrit, (SELECT count(*) FROM sel) AS nsel,
                 (SELECT count(*) FROM pick) AS npick,
                 (SELECT sum(pts) FROM pick) AS rubric_score,
                 (SELECT jsonb_object_agg(cid, jsonb_strip_nulls(jsonb_build_object(
                           'levelId', lid, 'points', pts, 'comment', nullif(comment, '')))) FROM pick) AS stored),
        fl AS (
          SELECT f.id FROM lms.files f
           WHERE f.tenant_id = ${t} AND f.id = ANY(${pgArray(fbIds)}::uuid[]) AND f.status = 'ready'
             AND (f.created_by = ${w.userId}::uuid
                  OR EXISTS (SELECT 1 FROM lms.assignment_feedback_files x
                              WHERE x.tenant_id = f.tenant_id AND x.file_id = f.id AND x.assignment_item_id = ${ITEM}))),
        chk AS (
          SELECT EXISTS (SELECT 1 FROM part) AS learner_ok,
                 coalesce((SELECT id FROM latest) = ${w.submissionId}::uuid, false) AS submission_ok,
                 (NOT c.has_rubric OR (c.ncrit = c.npick AND c.nsel = c.ncrit)) AS rubric_ok,
                 (CASE WHEN c.has_rubric THEN coalesce(${w.rawScore}::numeric, c.rubric_score)
                       ELSE ${w.rawScore}::numeric END) AS raw,
                 c.rubric_score AS rs, c.has_rubric, c.stored,
                 ((SELECT count(*) FROM fl) = ${fbIds.length}) AS files_ok
            FROM calc c),
        chk2 AS (
          SELECT chk.*, (chk.raw IS NOT NULL) AS score_given,
                 (chk.raw BETWEEN 0 AND (SELECT max_points FROM s)) AS score_ok,
                 (NOT chk.has_rubric OR chk.raw IS NOT DISTINCT FROM chk.rs
                  OR length(btrim(coalesce(${w.overrideReason}::text, ''))) > 0) AS override_ok
            FROM chk),
        valid AS (
          SELECT c.*, (c.learner_ok AND c.submission_ok AND c.rubric_ok AND coalesce(c.score_given, false)
                       AND coalesce(c.score_ok, false) AND c.override_ok AND c.files_ok) AS go
            FROM chk2 c),
        up AS (
          INSERT INTO lms.assignment_grades AS g
            (tenant_id, assignment_item_id, participant_id, submission_id, rubric_version_id, rubric_selection,
             rubric_score, raw_score, override_reason, feedback, graded_by)
          SELECT ${t}, ${ITEM}, (SELECT pid FROM part), ${w.submissionId}::uuid,
                 CASE WHEN v.has_rubric THEN (SELECT id FROM rv) END,
                 CASE WHEN v.has_rubric THEN v.stored END,
                 CASE WHEN v.has_rubric THEN v.rs END, v.raw,
                 CASE WHEN v.has_rubric AND v.raw IS DISTINCT FROM v.rs
                      THEN nullif(btrim(${w.overrideReason}::text), '') END,
                 ${w.feedback === undefined || w.feedback === null ? null : JSON.stringify(w.feedback)}::jsonb,
                 ${w.userId}::uuid
            FROM valid v WHERE v.go
          ON CONFLICT (tenant_id, assignment_item_id, participant_id) DO UPDATE SET
            submission_id = EXCLUDED.submission_id, rubric_version_id = EXCLUDED.rubric_version_id,
            rubric_selection = EXCLUDED.rubric_selection, rubric_score = EXCLUDED.rubric_score,
            raw_score = EXCLUDED.raw_score, override_reason = EXCLUDED.override_reason,
            feedback = ${w.feedbackGiven ? sql`EXCLUDED.feedback` : sql`g.feedback`},
            -- a grade of ANOTHER version starts without a waiver and, once released, with the penalty of THAT version
            penalty_waived = CASE WHEN g.submission_id = EXCLUDED.submission_id THEN g.penalty_waived ELSE false END,
            waive_reason = CASE WHEN g.submission_id = EXCLUDED.submission_id THEN g.waive_reason END,
            waived_by = CASE WHEN g.submission_id = EXCLUDED.submission_id THEN g.waived_by END,
            penalty_percent = CASE WHEN g.released_at IS NULL THEN NULL
                                   ELSE lms.assignment_penalty_percent((SELECT penalty_kind FROM s), (SELECT penalty_value FROM s),
                                          (SELECT penalty_cap FROM s), (SELECT late_seconds FROM latest)) END,
            graded_by = EXCLUDED.graded_by, graded_at = now(), updated_at = now()
          RETURNING g.*),
        fbdel AS (
          DELETE FROM lms.assignment_feedback_files x USING up
           WHERE ${w.feedbackFileIds === null ? sql`false` : sql`true`}
             AND x.tenant_id = ${t} AND x.assignment_item_id = up.assignment_item_id AND x.participant_id = up.participant_id
             AND x.file_id <> ALL(${pgArray(fbIds)}::uuid[])
          RETURNING x.file_id),
        fbunref AS (UPDATE lms.files f SET last_unreferenced_at = now() FROM fbdel
                     WHERE f.tenant_id = ${t} AND f.id = fbdel.file_id RETURNING 1),
        fbins AS (
          INSERT INTO lms.assignment_feedback_files (tenant_id, assignment_item_id, participant_id, file_id, position)
          SELECT ${t}, up.assignment_item_id, up.participant_id, o.file_id, o.ord::smallint
            FROM up, unnest(${pgArray(fbIds)}::uuid[]) WITH ORDINALITY AS o (file_id, ord)
           WHERE ${w.feedbackFileIds === null ? sql`false` : sql`true`}
          ON CONFLICT (tenant_id, assignment_item_id, participant_id, file_id) DO UPDATE SET position = EXCLUDED.position
          RETURNING 1),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.graded',
            targetType: 'assignment',
          },
          {
            from: sql`(SELECT up.assignment_item_id, up.participant_id, up.submission_id, up.raw_score,
                              up.rubric_version_id, (up.rubric_score IS NOT NULL AND up.raw_score <> up.rubric_score) AS overridden,
                              (SELECT o.raw_score FROM old o) AS before_raw FROM up) x`,
            targetId: sql`x.assignment_item_id`,
            metadata: sql`jsonb_build_object('participantId', x.participant_id, 'submissionId', x.submission_id,
                           'before', jsonb_build_object('rawScore', x.before_raw),
                           'after', jsonb_build_object('rawScore', x.raw_score, 'overridden', x.overridden,
                                                       'rubricVersionId', x.rubric_version_id))`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               coalesce((SELECT learner_ok FROM valid), false) AS learner_ok,
               coalesce((SELECT submission_ok FROM valid), false) AS submission_ok,
               coalesce((SELECT rubric_ok FROM valid), false) AS rubric_ok,
               coalesce((SELECT score_given FROM valid), false) AS score_given,
               coalesce((SELECT score_ok FROM valid), false) AS score_ok,
               coalesce((SELECT override_ok FROM valid), false) AS override_ok,
               coalesce((SELECT files_ok FROM valid), false) AS files_ok,
               (SELECT count(*) FROM au) + (SELECT count(*) FROM fbins) + (SELECT count(*) FROM fbunref) AS n,
               (SELECT jsonb_build_object(
                         'submissionId', up.submission_id, 'rawScore', up.raw_score, 'penaltyPercent', pen.pct,
                         'penaltyPoints', round(s.max_points * pen.pct / 100, 2), 'penaltyWaived', up.penalty_waived,
                         'finalScore', lms.assignment_final_points(up.raw_score, s.max_points, pen.pct),
                         'gradedAt', up.graded_at, 'releasedAt', up.released_at)
                  FROM up CROSS JOIN s
                  CROSS JOIN LATERAL (
                    SELECT CASE WHEN up.penalty_waived THEN 0::numeric
                                WHEN up.penalty_percent IS NOT NULL THEN up.penalty_percent
                                ELSE lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap,
                                       coalesce((SELECT late_seconds FROM latest), 0)) END AS pct) pen) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        learnerOk: r?.learner_ok === true,
        submissionOk: r?.submission_ok === true,
        rubricOk: r?.rubric_ok === true,
        scoreGiven: r?.score_given === true,
        scoreOk: r?.score_ok === true,
        overrideOk: r?.override_ok === true,
        filesOk: r?.files_ok === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    /** Waives (or restores) the late penalty of a learner's grade. The reason IS audited (it is not health data). */
    async setWaiver(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      learnerKey: string,
      waive: { reason: string } | null,
    ): Promise<{ acc: AccessRow | null; found: boolean; changed: boolean }> {
      const t = T(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        upd AS (
          UPDATE lms.assignment_grades g
             SET penalty_waived = ${waive !== null}::boolean, waive_reason = ${waive?.reason ?? null},
                 waived_by = ${waive ? a.userId : null}::uuid, updated_at = now()
            FROM it, lms.assignment_learners al
           WHERE g.tenant_id = ${t} AND g.assignment_item_id = it.id
             AND al.tenant_id = g.tenant_id AND al.assignment_item_id = g.assignment_item_id
             AND al.participant_id = g.participant_id AND al.learner_key = ${learnerKey}::uuid
          RETURNING g.assignment_item_id, g.participant_id, g.penalty_waived, g.waive_reason),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.penalty_waiver',
            targetType: 'assignment',
          },
          {
            from: sql`upd x`,
            targetId: sql`x.assignment_item_id`,
            metadata: sql`jsonb_build_object('participantId', x.participant_id, 'waived', x.penalty_waived,
                           'reason', x.waive_reason)`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT count(*) FROM upd) > 0 AS changed, (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, changed: r?.changed === true };
    },

    /**
     * Releases the grades of the latest versions (the penalty percent is FROZEN on the grade now). One audit entry with the
     * number of learners; `keys` null = everyone graded and not yet released.
     */
    async release(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      keys: string[] | null,
    ): Promise<{ acc: AccessRow | null; found: boolean; released: number }> {
      const t = T(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.* FROM lms.assignments s WHERE s.tenant_id = ${t} AND s.item_id = ${ITEM}),
        upd AS (
          UPDATE lms.assignment_grades g
             SET released_at = now(), released_by = ${a.userId}::uuid, updated_at = now(),
                 penalty_percent = lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap, gs.late_seconds)
            FROM s, lms.submissions gs, lms.assignment_learners al
           WHERE g.tenant_id = ${t} AND g.assignment_item_id = ${ITEM} AND g.released_at IS NULL
             AND gs.tenant_id = g.tenant_id AND gs.id = g.submission_id
             AND al.tenant_id = g.tenant_id AND al.assignment_item_id = g.assignment_item_id
             AND al.participant_id = g.participant_id
             ${keys ? sql`AND al.learner_key = ANY(${pgArray(keys)}::uuid[])` : sql``}
             AND ${ok}
             AND NOT EXISTS (SELECT 1 FROM lms.submissions n
                              WHERE n.tenant_id = g.tenant_id AND n.assignment_item_id = g.assignment_item_id
                                AND n.participant_id = g.participant_id AND n.version_no > gs.version_no)
          RETURNING g.participant_id),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assignment.released',
            targetType: 'assignment',
          },
          {
            from: sql`(SELECT count(*) AS n FROM upd) x WHERE x.n > 0`,
            targetId: ITEM,
            metadata: sql`jsonb_build_object('count', x.n, 'scope', ${keys ? 'selected' : 'all'}::text)`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT count(*) FROM upd)::integer AS released, (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        released: Number(r?.released ?? 0),
      };
    },

    /**
     * A file of this assignment for a grader / instructor: an attachment, a file of any version, or a feedback file. Returns
     * the anonymous code of the owner (for a neutral download name while blind) and whether the identity is hidden.
     */
    async staffFile(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      fileId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; file: Row | null }> {
      const t = T(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.anonymous_grading FROM lms.assignments s WHERE s.tenant_id = ${t} AND s.item_id = ${ITEM}),
        sf AS (
          SELECT sv.version_no, al.anon_code, g.released_at FROM lms.submission_files x
            JOIN lms.submissions sv ON sv.tenant_id = x.tenant_id AND sv.id = x.submission_id
            LEFT JOIN lms.assignment_learners al ON al.tenant_id = sv.tenant_id AND al.assignment_item_id = sv.assignment_item_id
                                                AND al.participant_id = sv.participant_id
            LEFT JOIN lms.assignment_grades g ON g.tenant_id = sv.tenant_id AND g.assignment_item_id = sv.assignment_item_id
                                             AND g.participant_id = sv.participant_id
           WHERE x.tenant_id = ${t} AND x.file_id = ${fileId}::uuid AND sv.assignment_item_id = ${ITEM})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT jsonb_build_object('storageKey', f.storage_key, 'name', f.original_name,
                         'contentType', f.content_type,
                         'neutralName', (SELECT EXISTS (SELECT 1 FROM sf) AND s.anonymous_grading AND (SELECT released_at FROM sf) IS NULL FROM s),
                         'anonCode', (SELECT anon_code FROM sf), 'versionNo', (SELECT version_no FROM sf))
                  FROM lms.files f
                 WHERE f.tenant_id = ${t} AND f.id = ${fileId}::uuid AND f.status = 'ready' AND EXISTS (SELECT 1 FROM it)
                   AND (EXISTS (SELECT 1 FROM sf)
                        OR EXISTS (SELECT 1 FROM lms.assignment_attachments x
                                    WHERE x.tenant_id = ${t} AND x.assignment_item_id = ${ITEM} AND x.file_id = f.id)
                        OR EXISTS (SELECT 1 FROM lms.assignment_feedback_files x
                                    WHERE x.tenant_id = ${t} AND x.assignment_item_id = ${ITEM} AND x.file_id = f.id))) AS file`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        file: (r?.file as Row | null) ?? null,
      };
    },

    /**
     * Everything the ZIP needs, ONE row per learner who has handed in: the latest version with its files, the identity (NULL
     * while blind) and the status. Never the bytes: the service streams them from storage.
     */
    async zipManifest(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      blind: boolean;
      missing: number;
      rows: Row[];
    }> {
      const t = T(a);
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${classCtes(a, itemId, {})}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT anonymous_grading FROM s) AS blind,
               (SELECT count(*) FROM r WHERE r.learner_key IS NULL)::integer AS missing,
               coalesce((SELECT jsonb_agg(${rowJson(sql`r`)} || jsonb_build_object(
                           'penaltyPercent', lms.assignment_penalty_percent(s.penalty_kind, s.penalty_value, s.penalty_cap, r.late_seconds),
                           'text', sv.text_body, 'link', sv.link_url,
                           'files', coalesce((SELECT jsonb_agg(jsonb_build_object('fileId', f.id, 'name', f.original_name,
                                                                                   'size', f.size_bytes) ORDER BY sf.position)
                                                FROM lms.submission_files sf
                                                JOIN lms.files f ON f.tenant_id = sf.tenant_id AND f.id = sf.file_id
                                               WHERE sf.tenant_id = ${t} AND sf.submission_id = r.sub_id), '[]'::jsonb))
                           ORDER BY r.anon_code)
                           FROM r CROSS JOIN s
                           JOIN lms.submissions sv ON sv.tenant_id = ${t} AND sv.id = r.sub_id
                          WHERE r.sub_id IS NOT NULL AND r.learner_key IS NOT NULL), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        blind: r?.blind === true,
        missing: Number(r?.missing ?? 0),
        rows: (r?.rows as Row[]) ?? [],
      };
    },

    // ================================================================ the gradebook interface (step 11)
    async finalScores(tx: Executor, tenantId: string, offeringId: string): Promise<Row[]> {
      const res = await tx.execute(
        sql`SELECT * FROM lms.assignment_final_scores(${tenantId}::uuid, ${offeringId}::uuid)`,
      );
      return res.rows as Row[];
    },
  };
}
export type AssignmentsRepository = ReturnType<typeof createAssignmentsRepository>;

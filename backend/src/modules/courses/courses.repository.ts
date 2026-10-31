import { type SQL, sql } from 'drizzle-orm';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import { type AccessRow, type AccessSpec, accessCte } from './courses.access';

// SQL only. Every function receives the transaction from the service and sends ONE statement (data-
// modifying CTEs: access check + lock + change + audit entry). Rows come back as JSON, snake_case.

export type Row = Record<string, unknown>;

export interface AuditStamp {
  id: string;
  actorUserId: string;
}

// ------------------------------------------------------------------ display shapes
const courseRow = (src: SQL) => sql`
  SELECT c.id, c.code, c.title, c.description, c.credits::float8 AS credits, c.department_id,
         d.code AS department_code, d.name AS department_name, c.archived_at, c.created_at, c.updated_at
    FROM ${src} c
    LEFT JOIN lms.departments d ON d.tenant_id = c.tenant_id AND d.id = c.department_id`;

/** `participation` is an SQL expression for the caller's part (text or null). */
const offeringRow = (src: SQL, participation: SQL) => sql`
  SELECT o.id, o.course_id, c.code AS course_code, c.title AS course_title,
         coalesce(o.title_override, c.title) AS title, o.label, o.term_id, t.name AS term_name,
         o.status::text AS status, o.copy_status, o.completion_threshold, o.behind_after_days,
         ${participation} AS my_participation,
         (SELECT count(*) FROM lms.offering_sections s
           WHERE s.tenant_id = o.tenant_id AND s.offering_id = o.id)::int AS section_count,
         o.created_at, o.updated_at
    FROM ${src} o
    JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
    JOIN lms.terms t ON t.tenant_id = o.tenant_id AND t.id = o.term_id`;

/** The caller's active participation in the offering `o` (a correlated scalar subquery). */
const myParticipation = (userId: string) => sql`(
  SELECT p.participation::text FROM lms.course_participants p
    JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
   WHERE p.tenant_id = o.tenant_id AND p.offering_id = o.id AND m.user_id = ${userId}::uuid
     AND p.status = 'active' LIMIT 1)`;

export interface CourseListFilter {
  q?: string | undefined;
  /** a department id, 'none' for no department */
  department?: string | undefined;
  includeArchived: boolean;
}

export interface CourseValues {
  title?: string;
  description?: string;
  credits?: number | null;
  department_id?: string | null;
  archived?: boolean;
}

export interface ParticipantInput {
  userId: string;
  participation: 'instructor' | 'assistant' | 'learner';
}

/** `{ acc, row }` of the statements that read one offering. */
export interface AccessResult<T = Row> {
  acc: AccessRow | null;
  row: T | null;
}

const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;

export function createCoursesRepository() {
  return {
    // ---------------------------------------------------------------- courses
    async listCourses(
      tx: Executor,
      tenantId: string,
      f: CourseListFilter,
      page: { limit: number; after?: string | undefined },
    ): Promise<Row[]> {
      const q = f.q ? sql`AND (lower(c.code) LIKE ${f.q} OR lower(c.title) LIKE ${f.q})` : sql``;
      const dept =
        f.department === undefined
          ? sql``
          : f.department === 'none'
            ? sql`AND c.department_id IS NULL`
            : sql`AND c.department_id = ${f.department}::uuid`;
      const archived = f.includeArchived ? sql`` : sql`AND c.archived_at IS NULL`;
      const after = page.after ? sql`AND c.id > ${page.after}::uuid` : sql``;
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          ${courseRow(sql`(SELECT * FROM lms.courses c WHERE c.tenant_id = ${tenantId}::uuid
                           ${q} ${dept} ${archived} ${after} ORDER BY c.id LIMIT ${page.limit + 1})`)}
          ORDER BY c.id
        ) r`);
      return res.rows.map((r) => r.row as Row);
    },

    async getCourse(tx: Executor, tenantId: string, id: string): Promise<Row | null> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          ${courseRow(sql`(SELECT * FROM lms.courses c WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${id}::uuid)`)}
        ) r`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    async createCourse(
      tx: Executor,
      tenantId: string,
      v: {
        id: string;
        code: string;
        title: string;
        description: string;
        credits: number | null;
        departmentId: string | null;
      },
      audit: AuditStamp,
    ): Promise<Row> {
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId,
          actorUserId: audit.actorUserId,
          action: 'course.created',
          targetType: 'course',
        },
        {
          from: sql`ins`,
          targetId: sql`ins.id::text`,
          metadata: sql`jsonb_build_object('after', to_jsonb(ins))`,
        },
      );
      const res = await tx.execute(sql`
        WITH ins AS (
          INSERT INTO lms.courses (id, tenant_id, code, title, description, credits, department_id)
          VALUES (${v.id}::uuid, ${tenantId}::uuid, ${v.code}, ${v.title}, ${v.description},
                  ${v.credits}::numeric, ${v.departmentId}::uuid)
          RETURNING *
        ), aud AS (${aud})
        SELECT to_jsonb(r) AS row FROM (${courseRow(sql`ins`)}) r`);
      return res.rows[0]?.row as Row;
    },

    async updateCourse(
      tx: Executor,
      tenantId: string,
      id: string,
      v: CourseValues,
      audit: AuditStamp,
    ): Promise<Row | null> {
      const parts: SQL[] = [];
      if (v.title !== undefined) parts.push(sql`title = ${v.title}`);
      if (v.description !== undefined) parts.push(sql`description = ${v.description}`);
      if (v.credits !== undefined) parts.push(sql`credits = ${v.credits}::numeric`);
      if (v.department_id !== undefined) parts.push(sql`department_id = ${v.department_id}::uuid`);
      if (v.archived !== undefined) {
        parts.push(
          v.archived ? sql`archived_at = coalesce(x.archived_at, now())` : sql`archived_at = NULL`,
        );
      }
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId,
          actorUserId: audit.actorUserId,
          action: 'course.updated',
          targetType: 'course',
        },
        {
          from: sql`old JOIN upd ON upd.id = old.id`,
          targetId: sql`old.id::text`,
          metadata: sql`jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(upd))`,
        },
      );
      const res = await tx.execute(sql`
        WITH old AS (
          SELECT * FROM lms.courses WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE
        ), upd AS (
          UPDATE lms.courses x SET ${sql.join(parts, sql`, `)}, updated_at = now()
            FROM old WHERE x.tenant_id = ${tenantId}::uuid AND x.id = old.id RETURNING x.*
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(r) FROM (${courseRow(sql`upd`)}) r) AS row`);
      return (res.rows[0]?.row as Row | undefined) ?? null;
    },

    // ---------------------------------------------------------------- offerings (administration)
    async listOfferings(
      tx: Executor,
      tenantId: string,
      userId: string,
      f: {
        courseId?: string | undefined;
        termId?: string | undefined;
        status?: string | undefined;
      },
      page: { limit: number; after?: string | undefined },
    ): Promise<Row[]> {
      const course = f.courseId ? sql`AND o.course_id = ${f.courseId}::uuid` : sql``;
      const term = f.termId ? sql`AND o.term_id = ${f.termId}::uuid` : sql``;
      const status = f.status ? sql`AND o.status = ${f.status}::lms.offering_status` : sql``;
      const after = page.after ? sql`AND o.id > ${page.after}::uuid` : sql``;
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          ${offeringRow(
            sql`(SELECT * FROM lms.course_offerings o WHERE o.tenant_id = ${tenantId}::uuid
                 ${course} ${term} ${status} ${after} ORDER BY o.id LIMIT ${page.limit + 1})`,
            myParticipation(userId),
          )}
          ORDER BY o.id
        ) r`);
      return res.rows.map((r) => r.row as Row);
    },

    /** My courses: offerings I take part in (a learner sees published ones only). Keyset on the offering id. */
    async listMine(
      tx: Executor,
      tenantId: string,
      userId: string,
      page: { limit: number; after?: string | undefined },
    ): Promise<Row[]> {
      const after = page.after ? sql`AND p.offering_id > ${page.after}::uuid` : sql``;
      const res = await tx.execute(sql`
        SELECT to_jsonb(r) AS row FROM (
          ${offeringRow(
            sql`(SELECT o.* FROM lms.course_participants p
                   JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
                   JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
                  WHERE p.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid AND p.status = 'active'
                    AND o.status <> 'archived' AND (p.participation <> 'learner' OR o.status = 'published')
                    ${after}
                  ORDER BY p.offering_id LIMIT ${page.limit + 1})`,
            myParticipation(userId),
          )}
          ORDER BY o.id
        ) r`);
      return res.rows.map((r) => r.row as Row);
    },

    async getOffering(tx: Executor, a: AccessSpec): Promise<AccessResult> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(r) FROM (${offeringRow(
                 sql`(SELECT o.* FROM lms.course_offerings o, acc
                       WHERE o.tenant_id = ${a.tenantId}::uuid AND o.id = acc.id AND acc.visible)`,
                 sql`(SELECT participation FROM acc)`,
               )}) r) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async createOffering(
      tx: Executor,
      tenantId: string,
      userId: string,
      v: {
        id: string;
        courseId: string;
        termId: string;
        label: string;
        titleOverride: string | null;
      },
      audit: AuditStamp,
    ): Promise<Row> {
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId,
          actorUserId: audit.actorUserId,
          action: 'offering.created',
          targetType: 'offering',
        },
        {
          from: sql`ins`,
          targetId: sql`ins.id::text`,
          metadata: sql`jsonb_build_object('after', to_jsonb(ins))`,
        },
      );
      const res = await tx.execute(sql`
        WITH ins AS (
          INSERT INTO lms.course_offerings (id, tenant_id, course_id, term_id, label, title_override)
          VALUES (${v.id}::uuid, ${tenantId}::uuid, ${v.courseId}::uuid, ${v.termId}::uuid, ${v.label},
                  ${v.titleOverride})
          RETURNING *
        ), aud AS (${aud})
        SELECT to_jsonb(r) AS row FROM (${offeringRow(sql`ins`, myParticipation(userId))}) r`);
      return res.rows[0]?.row as Row;
    },

    /**
     * Changes label / title (offering.manage) or the status. `fromStatuses` are the statuses the change may
     * start from; an offering in another status is reported as `{ changed: false }` with its status.
     */
    async changeOffering(
      tx: Executor,
      a: AccessSpec,
      change: {
        label?: string;
        titleOverride?: string | null;
        completionThreshold?: number;
        behindAfterDays?: number;
        status?: string;
        fromStatuses: string[];
      },
      audit: AuditStamp & { action: string },
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const parts: SQL[] = [];
      if (change.label !== undefined) parts.push(sql`label = ${change.label}`);
      if (change.titleOverride !== undefined)
        parts.push(sql`title_override = ${change.titleOverride}`);
      if (change.completionThreshold !== undefined)
        parts.push(sql`completion_threshold = ${change.completionThreshold}::smallint`);
      if (change.behindAfterDays !== undefined)
        parts.push(sql`behind_after_days = ${change.behindAfterDays}::smallint`);
      if (change.status !== undefined)
        parts.push(sql`status = ${change.status}::lms.offering_status`);
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId: a.tenantId,
          actorUserId: audit.actorUserId,
          action: audit.action,
          targetType: 'offering',
        },
        {
          from: sql`acc JOIN upd ON upd.id = acc.id`,
          targetId: sql`upd.id::text`,
          metadata: sql`jsonb_build_object('before', jsonb_build_object('status', acc.status), 'after', to_jsonb(upd))`,
        },
      );
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        upd AS (
          UPDATE lms.course_offerings x SET ${sql.join(parts, sql`, `)}, updated_at = now()
            FROM acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.id = acc.id AND acc.visible AND acc.allowed
             AND acc.status = ANY(${pgArray(change.fromStatuses)}::text[])
           RETURNING x.*
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(r) FROM (${offeringRow(sql`upd`, sql`(SELECT participation FROM acc)`)}) r) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    // ---------------------------------------------------------------- sections of an offering
    async listSections(
      tx: Executor,
      a: AccessSpec,
    ): Promise<{ acc: AccessRow | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.section_code) FROM (
                 SELECT os.section_id, s.code AS section_code, s.batch_id,
                        b.admission_year || '-' || b.graduation_year AS batch_label, pr.code AS program_code
                   FROM lms.offering_sections os
                   JOIN lms.sections s ON s.tenant_id = os.tenant_id AND s.id = os.section_id
                   JOIN lms.batches b ON b.tenant_id = s.tenant_id AND b.id = s.batch_id
                   JOIN lms.programs pr ON pr.tenant_id = b.tenant_id AND pr.id = b.program_id
                  WHERE os.tenant_id = ${a.tenantId}::uuid AND os.offering_id = ${a.offeringId}::uuid
                    AND EXISTS (SELECT 1 FROM acc WHERE visible AND allowed)) r), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[] | undefined) ?? [] };
    },

    /**
     * Adds (or removes) a section. The students of the section are marked for the enrolment sync in the same
     * statement (cost = the section's size, one set-based insert) and a sync job is queued.
     */
    async setSection(
      tx: Executor,
      a: AccessSpec,
      sectionId: string,
      op: 'add' | 'remove',
      audit: AuditStamp,
    ): Promise<{ acc: AccessRow | null; sectionFound: boolean; changed: boolean }> {
      const sec = sql`(SELECT s.id FROM lms.sections s WHERE s.tenant_id = ${a.tenantId}::uuid
                        AND s.id = ${sectionId}::uuid)`;
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId: a.tenantId,
          actorUserId: audit.actorUserId,
          action: op === 'add' ? 'offering.section_added' : 'offering.section_removed',
          targetType: 'offering',
        },
        {
          from: sql`chg`,
          targetId: sql`${a.offeringId}::text`,
          metadata: sql`jsonb_build_object('sectionId', chg.section_id)`,
        },
      );
      const change =
        op === 'add'
          ? sql`INSERT INTO lms.offering_sections (tenant_id, offering_id, section_id)
                SELECT ${a.tenantId}::uuid, acc.id, s.id FROM acc, lms.sections s
                 WHERE acc.visible AND acc.allowed AND acc.status <> 'archived'
                   AND s.tenant_id = ${a.tenantId}::uuid AND s.id = ${sectionId}::uuid AND s.archived_at IS NULL
                RETURNING section_id`
          : sql`DELETE FROM lms.offering_sections os USING acc
                 WHERE acc.visible AND acc.allowed AND acc.status <> 'archived'
                   AND os.tenant_id = ${a.tenantId}::uuid AND os.offering_id = acc.id
                   AND os.section_id = ${sectionId}::uuid
                RETURNING os.section_id`;
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        chg AS (${change}),
        marked AS (
          SELECT lms.course_sync_mark(array_agg(p.tenant_id), array_agg(p.membership_id))
            FROM lms.member_profiles p
           WHERE p.tenant_id = ${a.tenantId}::uuid AND p.section_id = ${sectionId}::uuid
             AND EXISTS (SELECT 1 FROM chg)
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, ${sec} IS NOT NULL AS section_found,
               EXISTS (SELECT 1 FROM chg) AS changed, (SELECT count(*) FROM marked) AS m`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        sectionFound: r?.section_found === true,
        changed: r?.changed === true,
      };
    },

    // ---------------------------------------------------------------- participants
    async listParticipants(
      tx: Executor,
      a: AccessSpec,
      f: { participation?: string | undefined; includeRemoved: boolean },
      page: { limit: number; after?: string | undefined },
    ): Promise<{ acc: AccessRow | null; rows: Row[] }> {
      const part = f.participation
        ? sql`AND p.participation = ${f.participation}::lms.participation_type`
        : sql``;
      const status = f.includeRemoved ? sql`` : sql`AND p.status = 'active'`;
      const after = page.after ? sql`AND p.id > ${page.after}::uuid` : sql``;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM (
                 SELECT p.id, m.user_id, u.display_name, u.email, p.participation::text AS participation,
                        p.source::text AS source, s.code AS section_code, p.status::text AS status, p.created_at
                   FROM (SELECT * FROM lms.course_participants p
                          WHERE p.tenant_id = ${a.tenantId}::uuid AND p.offering_id = ${a.offeringId}::uuid
                            AND EXISTS (SELECT 1 FROM acc WHERE visible AND allowed)
                            ${part} ${status} ${after}
                          ORDER BY p.id LIMIT ${page.limit + 1}) p
                   JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
                   JOIN lms.users u ON u.id = m.user_id
                   LEFT JOIN lms.sections s ON s.tenant_id = p.tenant_id AND s.id = p.source_section_id) r),
                 '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), rows: (r?.rows as Row[] | undefined) ?? [] };
    },

    /**
     * Adds a person (or changes an existing row to manual, active, with the given part: re-adding someone an
     * administrator removed, or turning a section learner into a manual participant).
     */
    async upsertParticipant(
      tx: Executor,
      a: AccessSpec,
      v: ParticipantInput & { id: string },
      audit: AuditStamp,
    ): Promise<{ acc: AccessRow | null; memberFound: boolean; row: Row | null }> {
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId: a.tenantId,
          actorUserId: audit.actorUserId,
          action: 'participant.added',
          targetType: 'offering',
        },
        {
          from: sql`up JOIN mem ON mem.id = up.membership_id`,
          targetId: sql`${a.offeringId}::text`,
          metadata: sql`jsonb_build_object('userId', mem.user_id, 'participation', up.participation)`,
        },
      );
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        mem AS (
          SELECT m.id, m.user_id FROM lms.tenant_memberships m
           WHERE m.tenant_id = ${a.tenantId}::uuid AND m.user_id = ${v.userId}::uuid AND m.status = 'active'
        ), up AS (
          INSERT INTO lms.course_participants (id, tenant_id, offering_id, membership_id, participation, source)
          SELECT ${v.id}::uuid, ${a.tenantId}::uuid, acc.id, mem.id, ${v.participation}::lms.participation_type, 'manual'
            FROM acc, mem WHERE acc.visible AND acc.allowed AND acc.status <> 'archived'
          ON CONFLICT (tenant_id, offering_id, membership_id) DO UPDATE
             SET participation = EXCLUDED.participation, source = 'manual', source_section_id = NULL,
                 status = 'active', removed_reason = NULL, updated_at = now()
          RETURNING *
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM mem) AS member_found,
               (SELECT to_jsonb(r) FROM (${participantRow(sql`up`)}) r) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        memberFound: r?.member_found === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    /** Changes a participant's part (to manual) or removes them (sticky: the sync never re-adds them). */
    async changeParticipant(
      tx: Executor,
      a: AccessSpec,
      participantId: string,
      change: { participation: string } | { remove: true },
      audit: AuditStamp,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const set =
        'participation' in change
          ? sql`participation = ${change.participation}::lms.participation_type, source = 'manual',
                source_section_id = NULL, status = 'active', removed_reason = NULL`
          : sql`status = 'removed', removed_reason = 'manual'`;
      const aud = auditInsertFrom(
        {
          id: audit.id,
          tenantId: a.tenantId,
          actorUserId: audit.actorUserId,
          action: 'participation' in change ? 'participant.changed' : 'participant.removed',
          targetType: 'offering',
        },
        {
          from: sql`upd JOIN lms.tenant_memberships m ON m.tenant_id = upd.tenant_id AND m.id = upd.membership_id`,
          targetId: sql`${a.offeringId}::text`,
          metadata: sql`jsonb_build_object('userId', m.user_id, 'participation', upd.participation)`,
        },
      );
      const res = await tx.execute(sql`
        WITH ${accessCte({ ...a, lock: true })},
        upd AS (
          UPDATE lms.course_participants x SET ${set}, updated_at = now() FROM acc
           WHERE x.tenant_id = ${a.tenantId}::uuid AND x.offering_id = acc.id AND x.id = ${participantId}::uuid
             AND acc.visible AND acc.allowed AND acc.status <> 'archived'
           RETURNING x.*
        ), aud AS (${aud})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT to_jsonb(r) FROM (${participantRow(sql`upd`)}) r) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    // ---------------------------------------------------------------- enrolment sync (worker)
    /**
     * One bounded batch: takes up to `limit` pending members, deletes them from the pending table and applies
     * their enrolments, in this transaction. Returns how many members it took (a short batch = nothing left).
     * Learners enrolled through a section follow the student's current section; manual participants and
     * people an administrator removed are never touched; archived offerings are frozen.
     */
    async syncBatch(tx: Executor, tenantId: string, limit: number): Promise<number> {
      // MATERIALIZED: the rows are picked (and locked) ONCE; as a plain IN-subquery the planner may re-run the
      // LIMIT ... SKIP LOCKED pick per candidate row and delete more than `limit` rows
      const claimed = await tx.execute(sql`
        WITH pick AS MATERIALIZED (
          SELECT s.membership_id FROM lms.course_sync_pending s
           WHERE s.tenant_id = ${tenantId}::uuid ORDER BY s.membership_id LIMIT ${limit}
           FOR UPDATE SKIP LOCKED),
        c AS (
          DELETE FROM lms.course_sync_pending d USING pick
           WHERE d.tenant_id = ${tenantId}::uuid AND d.membership_id = pick.membership_id
          RETURNING d.membership_id)
        -- Plan safety (transaction-local): a college that was just bulk-loaded has NO statistics, so the planner
        -- believes course_participants is tiny and picks a sequential scan per member (measured: batch time grew
        -- from 0.5 s to 3 s as the table filled, 40 s for the first sync of 10,000 students). Every lookup of the
        -- apply statement has an index, so sequential scans are switched off for this transaction.
        SELECT set_config('enable_seqscan', 'off', true) AS plan_guard, coalesce(array_agg(membership_id), '{}') AS ids
          FROM c`);
      const ids = (claimed.rows[0]?.ids as string[] | undefined) ?? [];
      if (ids.length === 0) return 0;
      await tx.execute(syncApplyStatement(tenantId, ids));
      return ids.length;
    },
  };
}
export type CoursesRepository = ReturnType<typeof createCoursesRepository>;

/**
 * The statement that applies the enrolment changes of ONE batch of members (exported for the profiler:
 * `SYNC_PROFILE=1 pnpm --filter @lms/backend run bench:courses` runs EXPLAIN (ANALYZE, BUFFERS) on it).
 * Every lookup is by a unique key per member (LATERAL ... OFFSET 0): linear whatever the statistics say.
 */
export function syncApplyStatement(tenantId: string, memberIds: string[]): SQL {
  const idArray = pgArray(memberIds);
  const t = sql`${tenantId}::uuid`;
  return sql`
    WITH batch AS (SELECT b.membership_id FROM unnest(${idArray}::uuid[]) AS b(membership_id)),
    -- the status of each member's MEMBERSHIP (one primary-key lookup per member: only id is compared, so the
    -- planner cannot pick a (tenant_id, ...) index it believes is selective when it has no statistics; row-level
    -- security still restricts the lookup to this college)
    mem AS MATERIALIZED (
      SELECT b.membership_id,
             (SELECT m.status::text FROM lms.tenant_memberships m
               WHERE m.id = b.membership_id) AS status
        FROM batch b
    ),
    -- each ACTIVE student's section: one lookup by the unique key (tenant, membership) per member
    stu AS MATERIALIZED (
      SELECT x.membership_id, x.section_id
        FROM mem
        CROSS JOIN LATERAL (
          SELECT mem.membership_id, p.section_id, p.profile_type FROM lms.member_profiles p
           WHERE p.tenant_id = ${t} AND p.membership_id = mem.membership_id
           OFFSET 0) x
       WHERE mem.status = 'active' AND x.profile_type = 'student' AND x.section_id IS NOT NULL
    ),
    -- the offerings enrolling that section: one index probe (tenant, section) per member
    wanted AS MATERIALIZED (
      SELECT stu.membership_id, w.offering_id, stu.section_id
        FROM stu
        CROSS JOIN LATERAL (
          SELECT os.offering_id FROM lms.offering_sections os
           WHERE os.tenant_id = ${t} AND os.section_id = stu.section_id
           OFFSET 0) w
       WHERE (SELECT o.status FROM lms.course_offerings o WHERE o.id = w.offering_id) <> 'archived'
    ),
    -- the members' ACTIVE participations (index course_participants_member_idx), one probe per member
    mine AS MATERIALIZED (
      SELECT c.id, c.membership_id, c.offering_id, c.source
        FROM batch b
        CROSS JOIN LATERAL (
          SELECT cp.id, cp.membership_id, cp.offering_id, cp.source FROM lms.course_participants cp
           WHERE cp.tenant_id = ${t} AND cp.membership_id = b.membership_id AND cp.status = 'active'
           OFFSET 0) c
       WHERE (SELECT o.status FROM lms.course_offerings o WHERE o.id = c.offering_id) <> 'archived'
    ),
    -- their CLOSED participations, but only for members who are active again (index course_participants_closed_idx)
    back AS MATERIALIZED (
      SELECT c.id
        FROM mem
        CROSS JOIN LATERAL (
          SELECT cp.id, cp.offering_id, cp.source, cp.removed_reason FROM lms.course_participants cp
           WHERE cp.tenant_id = ${t} AND cp.membership_id = mem.membership_id AND cp.status = 'removed'
           OFFSET 0) c
       WHERE mem.status = 'active' AND c.source = 'manual' AND c.removed_reason = 'membership'
         AND (SELECT o.status FROM lms.course_offerings o WHERE o.id = c.offering_id) <> 'archived'
    ),
    by_membership AS (
      -- the MEMBERSHIP was removed (soft removal): every participation of theirs is closed
      UPDATE lms.course_participants cp SET status = 'removed', removed_reason = 'membership', updated_at = now()
        FROM mine JOIN mem ON mem.membership_id = mine.membership_id AND mem.status = 'removed'
       WHERE cp.tenant_id = ${t} AND cp.id = mine.id
       RETURNING 1
    ),
    restored AS (
      UPDATE lms.course_participants cp SET status = 'active', removed_reason = NULL, updated_at = now()
        FROM back
       WHERE cp.tenant_id = ${t} AND cp.id = back.id
       RETURNING 1
    ),
    gone AS (
      -- section learners who left the section (or whose offering no longer enrols it)
      UPDATE lms.course_participants cp SET status = 'removed', removed_reason = 'sync', updated_at = now()
        FROM mine
       WHERE cp.tenant_id = ${t} AND cp.id = mine.id AND mine.source = 'section'
         AND (SELECT mem.status FROM mem WHERE mem.membership_id = mine.membership_id) <> 'removed'
         AND NOT EXISTS (SELECT 1 FROM wanted w
                          WHERE w.membership_id = mine.membership_id AND w.offering_id = mine.offering_id)
       RETURNING 1
    ),
    added AS (
      INSERT INTO lms.course_participants
        (id, tenant_id, offering_id, membership_id, participation, source, source_section_id)
      SELECT lms.uuid_v7(), ${t}, w.offering_id, w.membership_id, 'learner', 'section', w.section_id
        FROM wanted w
      ON CONFLICT (tenant_id, offering_id, membership_id) DO UPDATE
         SET status = 'active', removed_reason = NULL, source_section_id = EXCLUDED.source_section_id,
             updated_at = now()
       WHERE lms.course_participants.source = 'section'
         AND lms.course_participants.removed_reason IS DISTINCT FROM 'manual'
         AND (lms.course_participants.status = 'removed'
              OR lms.course_participants.source_section_id IS DISTINCT FROM EXCLUDED.source_section_id)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM gone) AS gone, (SELECT count(*) FROM added) AS added,
           (SELECT count(*) FROM by_membership) AS closed, (SELECT count(*) FROM restored) AS restored`;
}

/** The class-list shape of a course_participants row (`src` has its columns). */
function participantRow(src: SQL): SQL {
  return sql`
    SELECT p.id, m.user_id, u.display_name, u.email, p.participation::text AS participation,
           p.source::text AS source,
           (SELECT s.code FROM lms.sections s WHERE s.tenant_id = p.tenant_id AND s.id = p.source_section_id) AS section_code,
           p.status::text AS status, p.created_at
      FROM ${src} p
      JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
      JOIN lms.users u ON u.id = m.user_id`;
}

import { type SQL, sql } from 'drizzle-orm';
import { pgArray } from '../../core/pg-array';
import type { Executor } from '../../db/client';
import { auditInsertFrom } from '../audit';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. Instructor operations are ONE statement each (the access CTE travels with the work); learner operations are
// ONE call of a SECURITY DEFINER function (migration 0029) on an autocommit connection.
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const ok = sql`EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)`;

/** The assessment item of the offering the caller may use (`it`: at most one row). */
const itemCte = (a: AccessSpec, itemId: string): SQL => sql`it AS (
  SELECT i.id, i.title, i.published FROM lms.content_items i
   WHERE i.tenant_id = ${a.tenantId}::uuid AND i.offering_id = ${a.offeringId}::uuid AND i.id = ${itemId}::uuid
     AND i.kind = 'assessment' AND i.deleted_at IS NULL AND ${ok})`;
const T = (a: AccessSpec) => sql`${a.tenantId}::uuid`;
const ITEM = sql`(SELECT id FROM it)`;

const settingsJson = (s: SQL): SQL => sql`jsonb_build_object(
  'kind', ${s}.kind, 'opensAt', ${s}.opens_at, 'closesAt', ${s}.closes_at, 'timeLimitMinutes', ${s}.time_limit_minutes,
  'attemptsAllowed', ${s}.attempts_allowed, 'scoring', ${s}.scoring, 'shuffleQuestions', ${s}.shuffle_questions,
  'shuffleOptions', ${s}.shuffle_options, 'passingScore', ${s}.passing_score,
  'resultsVisibility', ${s}.results_visibility, 'answersVisibility', ${s}.answers_visibility)`;

const attemptRowJson = (at: SQL): SQL => sql`jsonb_build_object(
  'attemptId', ${at}.id, 'participantId', ${at}.participant_id, 'learnerName', u.display_name, 'learnerEmail', u.email,
  'attemptNo', ${at}.attempt_no, 'status', ${at}.status, 'startedAt', ${at}.started_at, 'submittedAt', ${at}.submitted_at,
  'submitKind', ${at}.submit_kind, 'score', ${at}.score, 'maxScore', ${at}.max_score, 'pendingManual', ${at}.pending_manual,
  'eventCount', ${at}.event_count, 'released', ${at}.released_at IS NOT NULL)`;

/** the option ids of a version as a sorted array (a regrade only re-scores when they are the same) */
const optionIds = (v: SQL): SQL => sql`(SELECT array_agg(o ->> 'id' ORDER BY o ->> 'id')
  FROM jsonb_array_elements(coalesce(${v}.presentation -> 'options', '[]'::jsonb)) o)`;

export interface SettingsPatch {
  kind?: string;
  opensAt?: string | null;
  closesAt?: string | null;
  timeLimitMinutes?: number | null;
  attemptsAllowed?: number;
  scoring?: string;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  passingScore?: number | null;
  resultsVisibility?: string;
  answersVisibility?: string;
}

export interface SlotRow {
  position: number;
  kind: 'fixed' | 'pool';
  questionId: string | null;
  tag: string | null;
  difficulty: string | null;
  count: number;
  points: number;
}

export interface RegradeInput {
  runId: string;
  questionId: string;
  action: 'rekey' | 'drop' | 'credit';
  toVersionId: string | null;
  dryRun: boolean;
  userId: string;
}

export function createAssessmentsRepository() {
  return {
    // ================================================================ configuration (instructors)
    async getConfig(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.* FROM lms.assessments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT jsonb_build_object(
                  'itemId', it.id, 'courseId', s.course_id, 'title', it.title, 'published', it.published,
                  'settings', ${settingsJson(sql`s`)},
                  'attemptsStarted', (SELECT count(*) FROM lms.attempts x WHERE x.tenant_id = ${T(a)} AND x.assessment_item_id = it.id),
                  'slots', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'position', sl.position, 'kind', sl.kind, 'questionId', sl.question_id, 'tag', sl.tag,
                      'difficulty', sl.difficulty, 'count', sl.count, 'points', sl.points,
                      'question', CASE WHEN sl.kind = 'fixed' THEN (
                          SELECT jsonb_build_object('type', v.type, 'difficulty', v.difficulty,
                                                    'stem', v.presentation -> 'stem', 'status', q.status)
                            FROM lms.questions q
                            JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.id = q.current_version_id
                           WHERE q.tenant_id = sl.tenant_id AND q.id = sl.question_id) END,
                      'available', CASE WHEN sl.kind = 'pool' THEN (
                          SELECT count(*) FROM lms.questions q
                            JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.id = q.current_version_id
                           WHERE q.tenant_id = sl.tenant_id AND q.course_id = s.course_id AND q.status = 'active'
                             AND (sl.difficulty IS NULL OR v.difficulty = sl.difficulty)
                             AND (sl.tag IS NULL OR EXISTS (SELECT 1 FROM lms.question_tags t
                                   WHERE t.tenant_id = q.tenant_id AND t.question_id = q.id AND t.tag = sl.tag))) END)
                      ORDER BY sl.position)
                      FROM lms.assessment_slots sl
                     WHERE sl.tenant_id = ${T(a)} AND sl.assessment_item_id = it.id), '[]'::jsonb))
                  FROM it, s) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    async updateSettings(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      p: SettingsPatch,
    ): Promise<{ acc: AccessRow | null; settings: Row | null }> {
      const set: SQL[] = [];
      const col: [keyof SettingsPatch, string, string][] = [
        ['kind', 'kind', 'text'],
        ['opensAt', 'opens_at', 'timestamptz'],
        ['closesAt', 'closes_at', 'timestamptz'],
        ['timeLimitMinutes', 'time_limit_minutes', 'integer'],
        ['attemptsAllowed', 'attempts_allowed', 'integer'],
        ['scoring', 'scoring', 'text'],
        ['shuffleQuestions', 'shuffle_questions', 'boolean'],
        ['shuffleOptions', 'shuffle_options', 'boolean'],
        ['passingScore', 'passing_score', 'numeric'],
        ['resultsVisibility', 'results_visibility', 'text'],
        ['answersVisibility', 'answers_visibility', 'text'],
      ];
      for (const [k, c, type] of col) {
        if (p[k] !== undefined) set.push(sql`${sql.raw(c)} = ${p[k] as never}::${sql.raw(type)}`);
      }
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        upd AS (
          UPDATE lms.assessments s SET ${sql.join(set, sql`, `)}, updated_at = now() FROM it
           WHERE s.tenant_id = ${T(a)} AND s.item_id = it.id RETURNING s.*)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, (SELECT ${settingsJson(sql`upd`)} FROM upd) AS settings`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), settings: (r?.settings as Row | null) ?? null };
    },

    /** Replaces the slots (upsert by position, delete the rest): one statement, every fixed question must be of the course. */
    async replaceSlots(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      slots: SlotRow[],
    ): Promise<{ acc: AccessRow | null; found: boolean; questionsOk: boolean }> {
      const payload = JSON.stringify(
        slots.map((s) => ({
          position: s.position,
          kind: s.kind,
          question_id: s.questionId,
          tag: s.tag,
          difficulty: s.difficulty,
          count: s.count,
          points: s.points,
        })),
      );
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        s AS (SELECT s.course_id FROM lms.assessments s WHERE s.tenant_id = ${T(a)} AND s.item_id = ${ITEM}),
        inp AS (
          SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
            AS x(position int, kind text, question_id uuid, tag text, difficulty text, count int, points numeric)),
        chk AS (
          SELECT NOT EXISTS (
            SELECT 1 FROM inp WHERE inp.kind = 'fixed' AND NOT EXISTS (
              SELECT 1 FROM lms.questions q, s WHERE q.tenant_id = ${T(a)} AND q.id = inp.question_id AND q.course_id = s.course_id)) AS ok),
        up AS (
          INSERT INTO lms.assessment_slots (tenant_id, assessment_item_id, position, kind, question_id, tag, difficulty, count, points)
          SELECT ${T(a)}, it.id, inp.position, inp.kind, inp.question_id, inp.tag, inp.difficulty, inp.count, inp.points
            FROM inp, it WHERE (SELECT ok FROM chk)
          ON CONFLICT (tenant_id, assessment_item_id, position) DO UPDATE SET
            kind = EXCLUDED.kind, question_id = EXCLUDED.question_id, tag = EXCLUDED.tag,
            difficulty = EXCLUDED.difficulty, count = EXCLUDED.count, points = EXCLUDED.points
          RETURNING 1),
        del AS (
          DELETE FROM lms.assessment_slots d
           WHERE d.tenant_id = ${T(a)} AND d.assessment_item_id = ${ITEM} AND d.position > ${slots.length}
             AND (SELECT ok FROM chk) RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT ok FROM chk) AS questions_ok, (SELECT count(*) FROM up) + (SELECT count(*) FROM del) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        questionsOk: r?.questions_ok === true,
      };
    },

    /** One sample draw, in the shape a learner gets (no keys). Raises LMS01 when a pool is too small. */
    async preview(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; questions: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               CASE WHEN EXISTS (SELECT 1 FROM it) THEN coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                   'position', d.pos, 'type', v.type, 'points', d.points, 'stem', v.presentation -> 'stem',
                   'images', coalesce(v.presentation -> 'images', '[]'::jsonb), 'maxWords', v.presentation -> 'maxWords',
                   'options', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o -> 'text')
                                                         ORDER BY array_position(d.option_order, o ->> 'id'))
                                          FROM jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) o), '[]'::jsonb),
                   'answer', NULL, 'rev', 0, 'flagged', false) ORDER BY d.pos)
                   FROM lms.assessment_draw(${a.tenantId}::uuid, ${itemId}::uuid) d
                   JOIN lms.question_versions v ON v.tenant_id = ${T(a)} AND v.id = d.version_id), '[]'::jsonb)
               ELSE '[]'::jsonb END AS questions`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        questions: (r?.questions as Row[]) ?? [],
      };
    },

    // ================================================================ accommodations
    async accommodations(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'participantId', x.participant_id, 'learnerName', u.display_name, 'learnerEmail', u.email,
                    'extraMinutes', x.extra_minutes, 'extendedCloseAt', x.extended_close_at, 'reason', x.reason,
                    'updatedAt', x.updated_at) ORDER BY u.display_name, x.participant_id)
                  FROM lms.assessment_accommodations x
                  JOIN lms.course_participants cp ON cp.tenant_id = x.tenant_id AND cp.id = x.participant_id
                  JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  JOIN lms.users u ON u.id = tm.user_id
                 WHERE x.tenant_id = ${T(a)} AND x.assessment_item_id = ${ITEM}), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, rows: (r?.rows as Row[]) ?? [] };
    },

    /** Sets (or changes) one learner's accommodation. The AUDIT entry carries minutes and dates, NEVER the reason. */
    async setAccommodation(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      participantId: string,
      v: { extraMinutes: number; extendedCloseAt: string | null; reason: string | null },
    ): Promise<{ acc: AccessRow | null; found: boolean; participantOk: boolean; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        part AS (SELECT p.id FROM lms.course_participants p
                  WHERE p.tenant_id = ${T(a)} AND p.offering_id = ${a.offeringId}::uuid AND p.id = ${participantId}::uuid
                    AND p.participation = 'learner' AND p.status = 'active'),
        old AS (SELECT x.extra_minutes, x.extended_close_at FROM lms.assessment_accommodations x
                 WHERE x.tenant_id = ${T(a)} AND x.assessment_item_id = ${ITEM} AND x.participant_id = ${participantId}::uuid),
        up AS (
          INSERT INTO lms.assessment_accommodations
            (tenant_id, assessment_item_id, participant_id, extra_minutes, extended_close_at, reason, set_by)
          SELECT ${T(a)}, it.id, part.id, ${v.extraMinutes}, ${v.extendedCloseAt}::timestamptz, ${v.reason}, ${a.userId}::uuid
            FROM it, part
          ON CONFLICT (tenant_id, assessment_item_id, participant_id) DO UPDATE SET
            extra_minutes = EXCLUDED.extra_minutes, extended_close_at = EXCLUDED.extended_close_at,
            reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, updated_at = now()
          RETURNING *),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assessment.accommodation_set',
            targetType: 'assessment',
          },
          {
            from: sql`(SELECT up.assessment_item_id, up.participant_id, up.extra_minutes, up.extended_close_at,
                              (SELECT jsonb_build_object('extraMinutes', o.extra_minutes, 'extendedCloseAt', o.extended_close_at) FROM old o) AS before
                         FROM up) x`,
            targetId: sql`x.assessment_item_id`,
            // minutes and dates only: the reason is health-related and stays out of the audit log
            metadata: sql`jsonb_build_object('participantId', x.participant_id, 'before', x.before,
                           'after', jsonb_build_object('extraMinutes', x.extra_minutes, 'extendedCloseAt', x.extended_close_at))`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               EXISTS (SELECT 1 FROM part) AS part_ok, (SELECT count(*) FROM au) AS n,
               (SELECT jsonb_build_object('participantId', up.participant_id, 'learnerName', u.display_name,
                         'learnerEmail', u.email, 'extraMinutes', up.extra_minutes,
                         'extendedCloseAt', up.extended_close_at, 'reason', up.reason, 'updatedAt', up.updated_at)
                  FROM up
                  JOIN lms.course_participants cp ON cp.tenant_id = ${T(a)} AND cp.id = up.participant_id
                  JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  JOIN lms.users u ON u.id = tm.user_id) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        participantOk: r?.part_ok === true,
        row: (r?.row as Row | null) ?? null,
      };
    },

    async removeAccommodation(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      participantId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; removed: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        del AS (
          DELETE FROM lms.assessment_accommodations x USING it
           WHERE x.tenant_id = ${T(a)} AND x.assessment_item_id = it.id AND x.participant_id = ${participantId}::uuid
          RETURNING x.assessment_item_id, x.participant_id, x.extra_minutes, x.extended_close_at),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assessment.accommodation_removed',
            targetType: 'assessment',
          },
          {
            from: sql`del x`,
            targetId: sql`x.assessment_item_id`,
            metadata: sql`jsonb_build_object('participantId', x.participant_id,
                           'before', jsonb_build_object('extraMinutes', x.extra_minutes, 'extendedCloseAt', x.extended_close_at))`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               EXISTS (SELECT 1 FROM del) AS removed, (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, removed: r?.removed === true };
    },

    // ================================================================ the learner (definer functions, autocommit)
    async start(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; itemId: string; grace: number },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.assessment_start(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.grace}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async readAttempt(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; attemptId: string; grace: number },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.attempt_read(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.attemptId}::uuid, ${p.grace}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async save(
      conn: Executor,
      p: {
        tenantId: string;
        userId: string;
        offeringId: string;
        attemptId: string;
        answers: unknown[];
        events: unknown[];
        grace: number;
        /** when the request ARRIVED (core/deadline.ts); null = now() */
        arrival: { at: Date; maxAgeSeconds: number } | null;
      },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.attempt_save(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.attemptId}::uuid, ${JSON.stringify(p.answers)}::jsonb, ${JSON.stringify(p.events)}::jsonb,
        ${p.grace}::integer, ${p.arrival?.at.toISOString() ?? null}::timestamptz,
        ${p.arrival?.maxAgeSeconds ?? 30}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async submit(
      conn: Executor,
      p: {
        tenantId: string;
        userId: string;
        offeringId: string;
        attemptId: string;
        grace: number;
        arrival: { at: Date; maxAgeSeconds: number } | null;
      },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.attempt_submit(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.attemptId}::uuid, ${p.grace}::integer,
        ${p.arrival?.at.toISOString() ?? null}::timestamptz, ${p.arrival?.maxAgeSeconds ?? 30}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async me(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; itemId: string; grace: number },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.assessment_me(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.itemId}::uuid, ${p.grace}::integer) AS r`);
      return res.rows[0]?.r as Row;
    },
    async result(
      conn: Executor,
      p: { tenantId: string; userId: string; offeringId: string; attemptId: string },
    ): Promise<Row> {
      const res =
        await conn.execute(sql`SELECT lms.attempt_result(${p.tenantId}::uuid, ${p.userId}::uuid,
        ${p.offeringId}::uuid, ${p.attemptId}::uuid) AS r`);
      return res.rows[0]?.r as Row;
    },
    /** Who is the caller in this offering? (only to tell "no such attempt" from "not your offering" after a miss) */
    async offeringAccess(tx: Executor, a: AccessSpec): Promise<AccessRow | null> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)} SELECT to_jsonb(acc) AS acc FROM acc`);
      return asAcc(res.rows[0]?.acc);
    },
    /** Worker: closes attempts past deadline + grace, all colleges, oldest first. */
    async sweep(conn: Executor, limit: number, grace: number): Promise<number> {
      const res = await conn.execute(
        sql`SELECT lms.assessment_sweep(${limit}::integer, ${grace}::integer) AS n`,
      );
      return Number(res.rows[0]?.n ?? 0);
    },

    /** An image of a question shown in THIS learner's own attempt (the only way a learner can download one). */
    async attemptFile(
      tx: Executor,
      p: {
        tenantId: string;
        userId: string;
        offeringId: string;
        attemptId: string;
        fileId: string;
      },
    ): Promise<Row | null> {
      const res = await tx.execute(sql`
        SELECT to_jsonb(x) AS file FROM (
          SELECT f.storage_key, f.original_name, f.content_type
            FROM lms.attempts a
            JOIN lms.course_participants cp ON cp.tenant_id = a.tenant_id AND cp.id = a.participant_id
            JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
            JOIN lms.attempt_questions aq ON aq.tenant_id = a.tenant_id AND aq.attempt_id = a.id
            JOIN lms.question_files qf ON qf.tenant_id = aq.tenant_id AND qf.question_version_id = aq.question_version_id
                                      AND qf.file_id = ${p.fileId}::uuid
            JOIN lms.files f ON f.tenant_id = qf.tenant_id AND f.id = qf.file_id AND f.status = 'ready'
           WHERE a.tenant_id = ${p.tenantId}::uuid AND a.id = ${p.attemptId}::uuid AND a.offering_id = ${p.offeringId}::uuid
             AND tm.user_id = ${p.userId}::uuid AND tm.status = 'active'
           LIMIT 1) x`);
      return (res.rows[0]?.file as Row | undefined) ?? null;
    },

    // ================================================================ instructors and assistants: attempts and grading
    async attempts(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      f: { status: string | null; limit: number; after: string | null },
    ): Promise<{ acc: AccessRow | null; found: boolean; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        page AS (
          SELECT at.* FROM lms.attempts at
           WHERE at.tenant_id = ${T(a)} AND at.assessment_item_id = ${ITEM}
             ${f.status ? sql`AND at.status = ${f.status}` : sql``}
             ${f.after ? sql`AND at.id < ${f.after}::uuid` : sql``}
           ORDER BY at.id DESC LIMIT ${f.limit + 1})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               coalesce((SELECT jsonb_agg(${attemptRowJson(sql`p`)} ORDER BY p.id DESC)
                           FROM page p
                           JOIN lms.course_participants cp ON cp.tenant_id = p.tenant_id AND cp.id = p.participant_id
                           JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                           JOIN lms.users u ON u.id = tm.user_id
                          WHERE EXISTS (SELECT 1 FROM it)), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, rows: (r?.rows as Row[]) ?? [] };
    },

    async gradingSummary(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; rows: Row[]; attemptsToGrade: number }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        g AS (
          SELECT aq.question_id,
                 count(*) FILTER (WHERE aq.manual_state = 'pending')::int AS pending,
                 count(*) FILTER (WHERE aq.manual_state = 'graded')::int AS graded,
                 max(aq.points) AS points,
                 (array_agg(aq.question_version_id ORDER BY aq.attempt_id DESC))[1] AS vid
            FROM lms.attempt_questions aq
           WHERE aq.tenant_id = ${T(a)} AND aq.assessment_item_id = ${ITEM} AND aq.manual_state IN ('pending', 'graded')
           GROUP BY aq.question_id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               CASE WHEN EXISTS (SELECT 1 FROM it) THEN coalesce((
                 SELECT jsonb_agg(jsonb_build_object('questionId', g.question_id, 'type', v.type,
                          'stem', v.presentation -> 'stem', 'points', g.points, 'pending', g.pending, 'graded', g.graded)
                          ORDER BY g.pending DESC, g.question_id)
                   FROM g JOIN lms.question_versions v ON v.tenant_id = ${T(a)} AND v.id = g.vid), '[]'::jsonb)
               ELSE '[]'::jsonb END AS rows,
               (SELECT count(*) FROM lms.attempts x WHERE x.tenant_id = ${T(a)} AND x.assessment_item_id = ${ITEM}
                   AND x.status = 'submitted' AND EXISTS (SELECT 1 FROM it)) AS to_grade`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        rows: (r?.rows as Row[]) ?? [],
        attemptsToGrade: Number(r?.to_grade ?? 0),
      };
    },

    /** The answers to ONE question (grade a question across students), keyset on the attempt id. */
    async gradingAnswers(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      f: {
        questionId: string;
        state: 'pending' | 'graded' | 'all';
        limit: number;
        after: string | null;
      },
    ): Promise<{ acc: AccessRow | null; found: boolean; question: Row | null; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        qv AS (SELECT v.type, v.presentation, v.answer_key
                 FROM lms.questions q JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.id = q.current_version_id
                WHERE q.tenant_id = ${T(a)} AND q.id = ${f.questionId}::uuid AND EXISTS (SELECT 1 FROM it)),
        page AS (
          SELECT aq.attempt_id, aq.position, aq.answer, aq.points, aq.score, aq.feedback, aq.manual_state
            FROM lms.attempt_questions aq
           WHERE aq.tenant_id = ${T(a)} AND aq.assessment_item_id = ${ITEM} AND aq.question_id = ${f.questionId}::uuid
             AND aq.manual_state ${f.state === 'all' ? sql`IN ('pending', 'graded')` : sql`= ${f.state}`}
             ${f.after ? sql`AND aq.attempt_id > ${f.after}::uuid` : sql``}
           ORDER BY aq.attempt_id LIMIT ${f.limit + 1})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT jsonb_build_object('questionId', ${f.questionId}::uuid, 'type', qv.type,
                       'stem', qv.presentation -> 'stem', 'key', qv.answer_key, 'maxWords', qv.presentation -> 'maxWords')
                  FROM qv) AS question,
               coalesce((SELECT jsonb_agg(jsonb_build_object('attemptId', p.attempt_id, 'position', p.position,
                          'learnerName', u.display_name, 'answer', p.answer, 'points', p.points, 'score', p.score,
                          'feedback', p.feedback, 'state', p.manual_state) ORDER BY p.attempt_id)
                           FROM page p
                           JOIN lms.attempts at ON at.tenant_id = ${T(a)} AND at.id = p.attempt_id
                           JOIN lms.course_participants cp ON cp.tenant_id = at.tenant_id AND cp.id = at.participant_id
                           JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                           JOIN lms.users u ON u.id = tm.user_id), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        question: (r?.question as Row | null) ?? null,
        rows: (r?.rows as Row[]) ?? [],
      };
    },

    /** One whole attempt for the instructor: answers, keys, marks, feedback, the integrity log. */
    async script(
      tx: Executor,
      a: AccessSpec,
      attemptId: string,
    ): Promise<{ acc: AccessRow | null; row: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        at AS (SELECT x.* FROM lms.attempts x
                WHERE x.tenant_id = ${T(a)} AND x.id = ${attemptId}::uuid AND x.offering_id = ${a.offeringId}::uuid AND ${ok})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT jsonb_build_object(
                  'attempt', (SELECT ${attemptRowJson(sql`at`)}
                                FROM lms.course_participants cp
                                JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                                JOIN lms.users u ON u.id = tm.user_id
                               WHERE cp.tenant_id = at.tenant_id AND cp.id = at.participant_id),
                  'feedback', at.feedback,
                  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.at) ORDER BY e.n)
                                        FROM lms.attempt_events e WHERE e.tenant_id = at.tenant_id AND e.attempt_id = at.id), '[]'::jsonb),
                  'questions', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                      'position', aq.position, 'questionId', aq.question_id, 'type', v.type, 'points', aq.points,
                      'dropped', aq.dropped, 'stem', v.presentation -> 'stem',
                      'images', coalesce(v.presentation -> 'images', '[]'::jsonb),
                      'options', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o -> 'text')
                                                            ORDER BY array_position(aq.option_order, o ->> 'id'))
                                             FROM jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) o), '[]'::jsonb),
                      'answer', aq.answer, 'key', k.answer_key, 'score', aq.score, 'state', aq.manual_state,
                      'feedback', aq.feedback, 'spentSeconds', aq.spent_ms / 1000) ORDER BY aq.position)
                      FROM lms.attempt_questions aq
                      JOIN LATERAL (SELECT vv.type, vv.presentation FROM lms.question_versions vv
                                     WHERE vv.tenant_id = aq.tenant_id AND vv.id = aq.question_version_id OFFSET 0) v ON true
                      JOIN LATERAL (SELECT vk.answer_key FROM lms.question_versions vk
                                     WHERE vk.tenant_id = aq.tenant_id AND vk.id = aq.scored_version_id OFFSET 0) k ON true
                     WHERE aq.tenant_id = at.tenant_id AND aq.attempt_id = at.id), '[]'::jsonb))
                  FROM at) AS row`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), row: (r?.row as Row | null) ?? null };
    },

    /**
     * Grades ONE answer that waits for a person and brings the attempt's totals up to date, in one statement. The
     * totals are computed with the new mark substituted (a data-modifying CTE is not visible to a sibling read).
     */
    async grade(
      tx: Executor,
      a: AccessSpec,
      attemptId: string,
      position: number,
      v: { score: number; feedback: string | null },
    ): Promise<{ acc: AccessRow | null; row: Row | null; found: boolean; scoreOk: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        cur AS (
          SELECT aq.tenant_id, aq.attempt_id, aq.position, aq.points
            FROM lms.attempt_questions aq JOIN lms.attempts at ON at.tenant_id = aq.tenant_id AND at.id = aq.attempt_id
           WHERE aq.tenant_id = ${T(a)} AND aq.attempt_id = ${attemptId}::uuid AND aq.position = ${position}
             AND at.offering_id = ${a.offeringId}::uuid AND at.status IN ('submitted', 'graded')
             AND aq.manual_state IN ('pending', 'graded') AND ${ok}),
        upd AS (
          UPDATE lms.attempt_questions aq
             SET score = ${v.score}, feedback = ${v.feedback}, manual_state = 'graded',
                 graded_by = ${a.userId}::uuid, graded_at = now()
            FROM cur
           WHERE aq.tenant_id = cur.tenant_id AND aq.attempt_id = cur.attempt_id AND aq.position = cur.position
             AND ${v.score} <= cur.points
          RETURNING aq.attempt_id),
        tot AS (
          SELECT coalesce(sum(CASE WHEN x.position = ${position} THEN ${v.score}::numeric ELSE x.score END) FILTER (WHERE NOT x.dropped), 0) AS score,
                 count(*) FILTER (WHERE x.position <> ${position} AND x.manual_state = 'pending')::int AS pending
            FROM lms.attempt_questions x
           WHERE x.tenant_id = ${T(a)} AND x.attempt_id = ${attemptId}::uuid AND EXISTS (SELECT 1 FROM upd)),
        att AS (
          UPDATE lms.attempts at
             SET score = tot.score, pending_manual = tot.pending,
                 status = CASE WHEN tot.pending = 0 THEN 'graded' ELSE 'submitted' END,
                 graded_at = CASE WHEN tot.pending = 0 THEN now() ELSE NULL END
            FROM tot
           WHERE at.tenant_id = ${T(a)} AND at.id = ${attemptId}::uuid
          RETURNING at.status, at.score, at.pending_manual)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM cur) AS found,
               (SELECT ${v.score} <= cur.points FROM cur) AS score_ok,
               (SELECT to_jsonb(att) FROM att) AS row`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        row: (r?.row as Row | null) ?? null,
        found: r?.found === true,
        scoreOk: r?.score_ok === true,
      };
    },

    async setFeedback(
      tx: Executor,
      a: AccessSpec,
      attemptId: string,
      feedback: string | null,
    ): Promise<{ acc: AccessRow | null; found: boolean }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        upd AS (UPDATE lms.attempts at SET feedback = ${feedback}
                 WHERE at.tenant_id = ${T(a)} AND at.id = ${attemptId}::uuid AND at.offering_id = ${a.offeringId}::uuid
                   AND at.status <> 'in_progress' AND ${ok} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM upd) AS found`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true };
    },

    // ================================================================ regrade, release, analysis
    /**
     * Re-scores every attempt that showed `questionId`, set based, and records before / after. `dryRun` runs the same
     * calculation and writes nothing. rekey: score again with another version of the question (refused when the option
     * ids differ: a changed set of options is a different question); drop: the question stops counting; credit:
     * everybody gets the points. A mark a PERSON gave is never replaced by a rekey.
     */
    async regrade(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      p: RegradeInput,
    ): Promise<{
      acc: AccessRow | null;
      found: boolean;
      compatible: boolean;
      versionOk: boolean;
      summary: Row | null;
    }> {
      const t = T(a);
      const writes = p.dryRun
        ? sql``
        : sql`,
        upd_aq AS (
          UPDATE lms.attempt_questions aq
             SET scored_version_id = CASE WHEN ${p.action} = 'rekey' THEN (SELECT id FROM tv) ELSE aq.scored_version_id END,
                 score = c.n_score, manual_state = c.n_state, dropped = c.n_dropped
            FROM calc c
           WHERE (SELECT ok FROM compat) AND aq.tenant_id = ${t} AND aq.attempt_id = c.attempt_id AND aq.position = c.position
          RETURNING 1),
        upd_att AS (
          UPDATE lms.attempts at
             SET score = x.score_after, max_score = x.max_after, pending_manual = x.pend_after,
                 status = CASE WHEN x.pend_after = 0 THEN 'graded' ELSE 'submitted' END,
                 graded_at = CASE WHEN x.pend_after = 0 THEN coalesce(at.graded_at, now()) ELSE NULL END
            FROM tot x
           WHERE (SELECT ok FROM compat) AND at.tenant_id = ${t} AND at.id = x.attempt_id
          RETURNING 1),
        run AS (
          INSERT INTO lms.regrade_runs (id, tenant_id, assessment_item_id, question_id, action, from_version_id, to_version_id,
                                        created_by, affected_attempts)
          SELECT ${p.runId}::uuid, ${t}, ${ITEM}, ${p.questionId}::uuid, ${p.action},
                 (SELECT min(scored_version_id::text)::uuid FROM aff), (SELECT id FROM tv), ${a.userId}::uuid,
                 (SELECT count(DISTINCT attempt_id) FROM calc)
           WHERE (SELECT ok FROM compat) AND EXISTS (SELECT 1 FROM calc)
          RETURNING id),
        chg_ins AS (
          INSERT INTO lms.regrade_changes (tenant_id, run_id, attempt_id, before_score, after_score, before_max, after_max)
          SELECT ${t}, run.id, c.attempt_id, c.before_score, c.after_score, c.before_max, c.after_max FROM chg c, run
          RETURNING 1),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assessment.regrade',
            targetType: 'assessment',
          },
          {
            from: sql`(SELECT run.id AS run_id, ${itemId}::uuid AS item_id,
                              (SELECT count(*) FROM chg) AS affected,
                              (SELECT count(*) FROM chg WHERE before_score IS DISTINCT FROM after_score) AS changed FROM run) x`,
            targetId: sql`x.item_id`,
            metadata: sql`jsonb_build_object('runId', x.run_id, 'questionId', ${p.questionId}::text, 'action', ${p.action}::text,
                           'toVersionId', ${p.toVersionId}::text, 'affectedAttempts', x.affected, 'changedScores', x.changed)`,
          },
        )} RETURNING 1)`;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        tv AS (SELECT v.id, v.type, v.answer_key, v.presentation FROM lms.question_versions v
                WHERE v.tenant_id = ${t} AND v.id = ${p.toVersionId}::uuid AND v.question_id = ${p.questionId}::uuid),
        aff AS MATERIALIZED (
          SELECT aq.attempt_id, aq.position, aq.points, aq.answer, aq.score, aq.manual_state, aq.dropped,
                 aq.scored_version_id, at.status AS astatus
            FROM lms.attempt_questions aq
            JOIN lms.attempts at ON at.tenant_id = aq.tenant_id AND at.id = aq.attempt_id
           WHERE aq.tenant_id = ${t} AND aq.assessment_item_id = ${ITEM} AND aq.question_id = ${p.questionId}::uuid
             ${
               p.action === 'rekey'
                 ? sql`AND aq.scored_version_id <> (SELECT id FROM tv)`
                 : p.action === 'drop'
                   ? sql`AND NOT aq.dropped`
                   : sql``
             }),
        compat AS (
          SELECT ${
            p.action === 'rekey'
              ? sql`EXISTS (SELECT 1 FROM tv) AND NOT EXISTS (
                      SELECT 1 FROM aff JOIN lms.question_versions ov ON ov.tenant_id = ${t} AND ov.id = aff.scored_version_id, tv
                       WHERE ov.type <> tv.type OR ${optionIds(sql`ov`)} IS DISTINCT FROM ${optionIds(sql`tv`)})`
              : sql`true`
          } AS ok),
        calc AS MATERIALIZED (
          SELECT aff.attempt_id, aff.position, aff.astatus, aff.score AS o_score, aff.dropped AS o_dropped, aff.manual_state AS o_state,
                 aff.points,
                 ${
                   p.action === 'rekey'
                     ? sql`CASE WHEN aff.astatus = 'in_progress' THEN aff.score
                                WHEN r.manual THEN CASE WHEN aff.manual_state = 'na' THEN 0 ELSE aff.score END
                                ELSE r.score END AS n_score,
                           CASE WHEN aff.astatus = 'in_progress' THEN aff.manual_state
                                WHEN r.manual THEN CASE WHEN aff.manual_state = 'na' THEN 'pending' ELSE aff.manual_state END
                                ELSE 'na' END AS n_state,
                           aff.dropped AS n_dropped`
                     : p.action === 'drop'
                       ? sql`aff.score AS n_score, aff.manual_state AS n_state, true AS n_dropped`
                       : sql`CASE WHEN aff.astatus = 'in_progress' THEN aff.score ELSE aff.points END AS n_score,
                             CASE WHEN aff.manual_state = 'pending' THEN 'na' ELSE aff.manual_state END AS n_state,
                             false AS n_dropped`
                 }
            FROM aff
            ${
              p.action === 'rekey'
                ? sql`CROSS JOIN LATERAL (SELECT (lms.score_answer(tv.type, tv.answer_key, aff.answer, aff.points)).* FROM tv) r`
                : sql``
            }
           WHERE ${ok}),
        tot AS MATERIALIZED (
          SELECT x.attempt_id,
                 coalesce(sum(coalesce(c.n_score, x.score)) FILTER (WHERE NOT coalesce(c.n_dropped, x.dropped)), 0) AS score_after,
                 coalesce(sum(x.points) FILTER (WHERE NOT coalesce(c.n_dropped, x.dropped)), 0) AS max_after,
                 count(*) FILTER (WHERE coalesce(c.n_state, x.manual_state) = 'pending')::int AS pend_after
            FROM (SELECT DISTINCT attempt_id FROM calc WHERE astatus <> 'in_progress') ids
            JOIN lms.attempt_questions x ON x.tenant_id = ${t} AND x.attempt_id = ids.attempt_id
            LEFT JOIN calc c ON c.attempt_id = x.attempt_id AND c.position = x.position
           GROUP BY x.attempt_id),
        chg AS MATERIALIZED (
          SELECT x.attempt_id, at.score AS before_score, x.score_after AS after_score,
                 at.max_score AS before_max, x.max_after AS after_max
            FROM tot x JOIN lms.attempts at ON at.tenant_id = ${t} AND at.id = x.attempt_id)
        ${writes}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT ok FROM compat) AS compatible,
               (${p.action} <> 'rekey' OR EXISTS (SELECT 1 FROM tv)) AS version_ok,
               (SELECT jsonb_build_object(
                  'affectedAttempts', (SELECT count(DISTINCT attempt_id) FROM calc),
                  'changedScores', (SELECT count(*) FROM chg WHERE before_score IS DISTINCT FROM after_score
                                                              OR before_max IS DISTINCT FROM after_max),
                  'averageBefore', (SELECT round(avg(before_score), 2) FROM chg),
                  'averageAfter', (SELECT round(avg(after_score), 2) FROM chg),
                  'changes', coalesce((SELECT jsonb_agg(jsonb_build_object('attemptId', z.attempt_id, 'learnerName', z.name,
                                'before', z.before_score, 'after', z.after_score, 'maxBefore', z.before_max, 'maxAfter', z.after_max)
                                ORDER BY z.delta DESC, z.attempt_id)
                      FROM (SELECT c.*, u.display_name AS name, abs(coalesce(c.after_score, 0) - coalesce(c.before_score, 0)) AS delta
                              FROM chg c
                              JOIN lms.attempts at ON at.tenant_id = ${t} AND at.id = c.attempt_id
                              JOIN lms.course_participants cp ON cp.tenant_id = at.tenant_id AND cp.id = at.participant_id
                              JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                              JOIN lms.users u ON u.id = tm.user_id
                             WHERE c.before_score IS DISTINCT FROM c.after_score OR c.before_max IS DISTINCT FROM c.after_max
                             ORDER BY delta DESC, c.attempt_id LIMIT 100) z), '[]'::jsonb))) AS summary
               ${p.dryRun ? sql`` : sql`, (SELECT count(*) FROM upd_aq) + (SELECT count(*) FROM upd_att) + (SELECT count(*) FROM run) + (SELECT count(*) FROM chg_ins) + (SELECT count(*) FROM au) AS n`}`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        compatible: r?.compatible === true,
        versionOk: r?.version_ok === true,
        summary: (r?.summary as Row | null) ?? null,
      };
    },

    async regrades(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; rows: Row[] }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)}
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'questionId', g.question_id, 'action', g.action,
                           'affectedAttempts', g.affected_attempts, 'createdAt', g.created_at, 'createdByName', u.display_name)
                           ORDER BY g.created_at DESC, g.id)
                           FROM lms.regrade_runs g LEFT JOIN lms.users u ON u.id = g.created_by
                          WHERE g.tenant_id = ${T(a)} AND g.assessment_item_id = ${ITEM}), '[]'::jsonb) AS rows`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), found: r?.found === true, rows: (r?.rows as Row[]) ?? [] };
    },

    async release(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
      attemptIds: string[] | null,
    ): Promise<{ acc: AccessRow | null; found: boolean; released: number; stillPending: number }> {
      const only = attemptIds ? sql`AND at.id = ANY(${pgArray(attemptIds)}::uuid[])` : sql``;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        upd AS (
          UPDATE lms.attempts at SET released_at = now()
           WHERE at.tenant_id = ${T(a)} AND at.assessment_item_id = ${ITEM} AND at.status = 'graded'
             AND at.released_at IS NULL ${only} AND EXISTS (SELECT 1 FROM it)
          RETURNING at.id),
        au AS (${auditInsertFrom(
          {
            id: sql`lms.uuid_v7()`,
            tenantId: a.tenantId,
            actorUserId: a.userId,
            action: 'assessment.release',
            targetType: 'assessment',
          },
          {
            from: sql`(SELECT count(*) AS n FROM upd HAVING count(*) > 0) x`,
            targetId: sql`${itemId}::uuid`,
            metadata: sql`jsonb_build_object('released', x.n)`,
          },
        )} RETURNING 1)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               (SELECT count(*) FROM upd) AS released,
               (SELECT count(*) FROM lms.attempts at WHERE at.tenant_id = ${T(a)} AND at.assessment_item_id = ${ITEM}
                   AND at.status = 'submitted' ${only} AND EXISTS (SELECT 1 FROM it)) AS still_pending,
               (SELECT count(*) FROM au) AS n`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        released: Number(r?.released ?? 0),
        stillPending: Number(r?.still_pending ?? 0),
      };
    },

    /** Item analysis from the attempts that were handed in. Aggregated from the rows when asked (not kept in counters). */
    async analysis(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; found: boolean; data: Row | null }> {
      const res = await tx.execute(sql`
        WITH ${accessCte(a)}, ${itemCte(a, itemId)},
        done AS MATERIALIZED (
          SELECT at.id, at.score, at.max_score, at.started_at, at.submitted_at FROM lms.attempts at
           WHERE at.tenant_id = ${T(a)} AND at.assessment_item_id = ${ITEM} AND at.status <> 'in_progress'),
        rows AS MATERIALIZED (
          SELECT aq.question_id, aq.points, aq.score, aq.answer, aq.spent_ms, aq.question_version_id, aq.attempt_id
            FROM lms.attempt_questions aq
           WHERE aq.tenant_id = ${T(a)} AND aq.assessment_item_id = ${ITEM} AND NOT aq.dropped
             AND aq.attempt_id IN (SELECT id FROM done)),
        per AS MATERIALIZED (
          SELECT r.question_id, count(*)::int AS total,
                 count(*) FILTER (WHERE r.answer IS NOT NULL)::int AS answered,
                 round(100.0 * count(*) FILTER (WHERE r.score >= r.points) / nullif(count(*) FILTER (WHERE r.score IS NOT NULL), 0), 1) AS correct_pct,
                 round(100.0 * avg(r.score / r.points), 1) AS avg_pct,
                 round(avg(r.spent_ms) / 1000.0, 1) AS avg_s,
                 max(r.points) AS points,
                 (array_agg(r.question_version_id ORDER BY r.attempt_id DESC))[1] AS vid
            FROM rows r GROUP BY r.question_id),
        picks AS MATERIALIZED (
          SELECT r.question_id, o.id, count(*)::int AS n
            FROM rows r, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.answer -> 'o') = 'array' THEN r.answer -> 'o' ELSE '[]'::jsonb END) o(id)
           GROUP BY r.question_id, o.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc, EXISTS (SELECT 1 FROM it) AS found,
               CASE WHEN EXISTS (SELECT 1 FROM it) THEN jsonb_build_object(
                 'attempts', (SELECT count(*) FROM done),
                 'averagePercent', (SELECT round(avg(100.0 * score / nullif(max_score, 0)), 1) FROM done WHERE score IS NOT NULL),
                 'averageMinutes', (SELECT round(avg(extract(epoch FROM submitted_at - started_at)) / 60.0, 1) FROM done),
                 'questions', coalesce((
                   SELECT jsonb_agg(jsonb_build_object(
                     'questionId', per.question_id, 'type', v.type, 'stem', v.presentation -> 'stem', 'points', per.points,
                     'answered', per.answered, 'total', per.total, 'correctPercent', per.correct_pct,
                     'averagePercent', per.avg_pct, 'averageSeconds', per.avg_s,
                     'options', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o -> 'text',
                                    'picked', coalesce((SELECT pk.n FROM picks pk WHERE pk.question_id = per.question_id AND pk.id = o ->> 'id'), 0),
                                    'correct', coalesce(v.answer_key -> 'correct' ? (o ->> 'id'), false)))
                                   FROM jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) o), '[]'::jsonb))
                     ORDER BY per.question_id)
                     FROM per JOIN lms.question_versions v ON v.tenant_id = ${T(a)} AND v.id = per.vid), '[]'::jsonb))
               END AS data`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        found: r?.found === true,
        data: (r?.data as Row | null) ?? null,
      };
    },

    // ================================================================ the interface of the gradebook (step 11)
    async finalScores(tx: Executor, tenantId: string, offeringId: string): Promise<Row[]> {
      const res = await tx.execute(
        sql`SELECT * FROM lms.assessment_final_scores(${tenantId}::uuid, ${offeringId}::uuid)`,
      );
      return res.rows as Row[];
    },
  };
}
export type AssessmentsRepository = ReturnType<typeof createAssessmentsRepository>;

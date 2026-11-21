import { type SQL, sql } from 'drizzle-orm';
import { SETTINGS_LOCK_CLASS, settingsLockKey } from '../../core/locks';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. Dashboards read the rollups (with their "as of") or a small bounded live statement. A staff call is ONE statement: the
// offering access CTE and the work travel together (4 round trips with the session lookup); the learner call is one definer function.
export type Row = Record<string, unknown>;
const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;
const T = (tenantId: string) => sql`${tenantId}::uuid`;

/** What a learner can see right now (the outline's rule). Required items only when asked. */
const visibleItems = (tenantId: string, offeringId: string, requiredOnly: boolean): SQL => sql`
  SELECT i.id, i.module_id, i.title, i.kind,
         greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at) AS eff_open
    FROM lms.content_items i
    JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
   WHERE i.tenant_id = ${T(tenantId)} AND i.offering_id = ${offeringId}::uuid
     AND i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published
     AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()
     ${requiredOnly ? sql`AND i.required` : sql``}`;

export interface SettingsRow {
  tz: string;
  atRisk: Row;
  analytics: Row | null;
  usage: Row | null;
}

export const REPORT_ROW_LIMIT = 100_000;

export function createAnalyticsRepository() {
  return {
    // ------------------------------------------------------------ activity, the rollup run (worker / request background)
    /** Records the day's activity of a user. Returns the instant the next local day starts. */
    async activityTouch(conn: Executor, tenantId: string, userId: string): Promise<Date> {
      const r = await conn.execute(
        sql`SELECT lms.activity_touch(${T(tenantId)}, ${userId}::uuid) AS next`,
      );
      return new Date((r.rows[0] as { next: string | Date }).next);
    },
    async rollupTenants(conn: Executor): Promise<string[]> {
      const r = await conn.execute(sql`SELECT tenant_id FROM lms.rollup_tenants()`);
      return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
    },
    /** One bounded refresh of one college; returns how many marks are still waiting. */
    async rollupRun(conn: Executor, tenantId: string, max: number, now?: Date): Promise<number> {
      const r = await conn.execute(
        sql`SELECT lms.rollup_run_tenant(${T(tenantId)}, ${(now ?? new Date()).toISOString()}::timestamptz, ${max}::int) AS left_n`,
      );
      return Number((r.rows[0] as { left_n: number | string }).left_n);
    },

    // ------------------------------------------------------------ settings
    /**
     * First statement of a settings PATCH: one writer at a time per college. The read that follows is a NEW statement (a new
     * snapshot), so it sees what the previous writer committed: without this two admins changing different fields lost one change.
     */
    async lockSettings(tx: Executor, tenantId: string): Promise<void> {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${settingsLockKey(tenantId)}::text, ${SETTINGS_LOCK_CLASS}::bigint))`,
      );
    },

    async getSettings(tx: Executor, tenantId: string): Promise<SettingsRow> {
      const r = await tx.execute(sql`
        SELECT lms.tenant_tz(${T(tenantId)}) AS tz, lms.atrisk_settings(${T(tenantId)}) AS at_risk,
               (SELECT value FROM lms.tenant_settings WHERE tenant_id = ${T(tenantId)} AND key = 'analytics') AS analytics,
               (SELECT value FROM lms.tenant_settings WHERE tenant_id = ${T(tenantId)} AND key = 'usage') AS usage`);
      const row = r.rows[0] as {
        tz: string;
        at_risk: Row;
        analytics: Row | null;
        usage: Row | null;
      };
      return { tz: row.tz, atRisk: row.at_risk, analytics: row.analytics, usage: row.usage };
    },
    /** ONE statement: validate the zone, upsert the four keys, audit with before and after. Returns false for an unknown zone. */
    async setSettings(
      tx: Executor,
      o: {
        tenantId: string;
        userId: string;
        timeZone: string;
        atRisk: Row;
        analytics: Row;
        usage: Row;
        before: Row;
        after: Row;
      },
    ): Promise<boolean> {
      const t = T(o.tenantId);
      const up = (key: string, value: SQL) => sql`
        INSERT INTO lms.tenant_settings (id, tenant_id, key, value)
        SELECT lms.uuid_v7(), ${t}, ${key}::text, ${value} FROM ok
        ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        RETURNING 1`;
      const r = await tx.execute(sql`
        WITH ok AS (SELECT 1 WHERE EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${o.timeZone}::text)),
        a AS (${up('timezone', sql`to_jsonb(${o.timeZone}::text)`)}),
        b AS (${up('atRisk', sql`${JSON.stringify(o.atRisk)}::jsonb`)}),
        c AS (${up('analytics', sql`${JSON.stringify(o.analytics)}::jsonb`)}),
        d AS (${up('usage', sql`${JSON.stringify(o.usage)}::jsonb`)}),
        au AS (
          INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
          SELECT lms.uuid_v7(), ${t}, ${o.userId}::uuid, 'analytics.settings_changed', 'tenant', ${o.tenantId}::text,
                 jsonb_build_object('before', ${JSON.stringify(o.before)}::jsonb, 'after', ${JSON.stringify(o.after)}::jsonb)
            FROM ok RETURNING 1)
        SELECT (SELECT count(*) FROM ok) AS ok, (SELECT count(*) FROM a) + (SELECT count(*) FROM b)
             + (SELECT count(*) FROM c) + (SELECT count(*) FROM d) + (SELECT count(*) FROM au) AS n`);
      return Number((r.rows[0] as { ok: number | string }).ok) === 1;
    },

    // ------------------------------------------------------------ learner
    async learnerDashboard(conn: Executor, tenantId: string, userId: string): Promise<Row> {
      const r = await conn.execute(
        sql`SELECT lms.learner_dashboard(${T(tenantId)}, ${userId}::uuid) AS d`,
      );
      return (r.rows[0] as { d: Row }).d;
    },

    // ------------------------------------------------------------ instructor: one offering
    async offeringDashboard(
      tx: Executor,
      a: AccessSpec,
    ): Promise<{ acc: AccessRow | null; data: Row | null }> {
      const t = T(a.tenantId);
      const o = sql`${a.offeringId}::uuid`;
      const r = await tx.execute(sql`
        WITH ${accessCte(a)},
        ok AS (SELECT 1 AS v FROM acc WHERE acc.visible AND acc.allowed),
        tz AS (SELECT lms.tenant_tz(${t}) AS z),
        lp AS MATERIALIZED (
          SELECT p.id AS pid FROM lms.course_participants p
           WHERE p.tenant_id = ${t} AND p.offering_id = ${o} AND p.participation = 'learner' AND p.status = 'active'
             AND EXISTS (SELECT 1 FROM ok)),
        vis AS MATERIALIZED (${visibleItems(a.tenantId, a.offeringId, true)}),
        mods AS (SELECT m.id, m.title, m.position FROM lms.content_modules m
                  WHERE m.tenant_id = ${t} AND m.offering_id = ${o} AND m.deleted_at IS NULL AND m.published),
        mod_part AS MATERIALIZED (
          SELECT v.module_id, ip.participant_id AS pid,
                 count(*) FILTER (WHERE ip.status = 'completed') AS done
            FROM lms.item_progress ip JOIN vis v ON v.id = ip.item_id
           WHERE ip.tenant_id = ${t} AND ip.offering_id = ${o} AND ip.participant_id IN (SELECT pid FROM lp)
           GROUP BY v.module_id, ip.participant_id),
        mod_tot AS MATERIALIZED (SELECT module_id, count(*) AS n FROM vis GROUP BY module_id),
        funnel AS (
          SELECT m.id, m.title, m.position, coalesce(mt.n, 0) AS n,
                 count(mp.pid) AS started,
                 count(mp.pid) FILTER (WHERE mt.n > 0 AND mp.done >= mt.n) AS completed
            FROM mods m
            LEFT JOIN mod_tot mt ON mt.module_id = m.id
            LEFT JOIN mod_part mp ON mp.module_id = m.id
           GROUP BY m.id, m.title, m.position, mt.n),
        latest AS MATERIALIZED (
          SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.assignment_item_id, s.participant_id
            FROM lms.submissions s
           WHERE s.tenant_id = ${t} AND s.offering_id = ${o} AND s.participant_id IN (SELECT pid FROM lp)
           ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
        backlog_s AS (
          SELECT count(*) AS n FROM latest l
           WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g
                              WHERE g.tenant_id = ${t} AND g.assignment_item_id = l.assignment_item_id
                                AND g.participant_id = l.participant_id AND g.submission_id = l.id)),
        backlog_a AS (
          SELECT count(*) AS n FROM lms.attempts x
           WHERE x.tenant_id = ${t} AND x.offering_id = ${o} AND x.status = 'submitted'
             AND x.participant_id IN (SELECT pid FROM lp)),
        titles AS (SELECT v.id, v.title FROM vis v),
        up AS (
          SELECT 'assignment_due' AS kind, a2.item_id, a2.due_at AS at
            FROM lms.assignments a2 JOIN titles ti ON ti.id = a2.item_id
           WHERE a2.tenant_id = ${t} AND a2.offering_id = ${o} AND a2.due_at > now() AND a2.due_at <= now() + interval '14 days'
          UNION ALL
          SELECT 'assessment_closes', s.item_id, s.closes_at
            FROM lms.assessments s JOIN titles ti ON ti.id = s.item_id
           WHERE s.tenant_id = ${t} AND s.offering_id = ${o} AND s.closes_at > now() AND s.closes_at <= now() + interval '14 days'
          UNION ALL
          SELECT 'assessment_opens', s.item_id, s.opens_at
            FROM lms.assessments s JOIN titles ti ON ti.id = s.item_id
           WHERE s.tenant_id = ${t} AND s.offering_id = ${o} AND s.opens_at > now() AND s.opens_at <= now() + interval '14 days'),
        up_page AS (SELECT up.*, ti.title FROM up JOIN titles ti ON ti.id = up.item_id ORDER BY up.at, up.item_id LIMIT 20),
        asm AS (
          SELECT s.item_id, ti.title,
                 count(x.id) AS attempts, count(DISTINCT x.participant_id) AS learners,
                 round(avg(x.score * 100 / nullif(x.max_score, 0)), 1) AS avg_pct,
                 CASE WHEN s.passing_score IS NULL OR count(x.id) = 0 THEN NULL
                      ELSE round(100.0 * count(x.id) FILTER (WHERE x.max_score > 0 AND x.score * 100 / x.max_score >= s.passing_score)
                                 / count(x.id), 1) END AS pass_pct
            FROM lms.assessments s
            JOIN titles ti ON ti.id = s.item_id
            LEFT JOIN lms.attempts x ON x.tenant_id = s.tenant_id AND x.assessment_item_id = s.item_id
                                    AND x.status = 'graded' AND x.participant_id IN (SELECT pid FROM lp)
           WHERE s.tenant_id = ${t} AND s.offering_id = ${o}
           GROUP BY s.item_id, ti.title, s.passing_score),
        risk AS (SELECT count(*) AS n FROM lms.atrisk_flags(${t}, now()) f
                  WHERE f.offering_id = ${o} AND EXISTS (SELECT 1 FROM ok)
                    AND (f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive)),
        recent AS (
          SELECT d.day, d.active_learners, d.items_completed, d.submissions, d.attempts
            FROM lms.rollup_offering_day d
           WHERE d.tenant_id = ${t} AND d.offering_id = ${o} AND EXISTS (SELECT 1 FROM ok)
             AND d.day > lms.local_day(now(), (SELECT z FROM tz)) - 30
           ORDER BY d.day)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
          (SELECT jsonb_build_object(
            'timeZone', (SELECT z FROM tz),
            'asOf', (SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${t} AND s.kind = 'offering_day'),
            'learners', (SELECT count(*) FROM lp),
            'backlog', jsonb_build_object('submissions', (SELECT n FROM backlog_s), 'attempts', (SELECT n FROM backlog_a)),
            'upcoming', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'offeringId', ${o}, 'offeringTitle', '',
                          'itemId', item_id, 'title', title, 'at', at) ORDER BY at, item_id) FROM up_page), '[]'::jsonb),
            'funnel', coalesce((SELECT jsonb_agg(jsonb_build_object('moduleId', id, 'title', title, 'requiredItems', n,
                          'started', started, 'completed', completed) ORDER BY position COLLATE "C") FROM funnel), '[]'::jsonb),
            'assessments', coalesce((SELECT jsonb_agg(jsonb_build_object('itemId', item_id, 'title', title, 'attempts', attempts,
                          'learners', learners, 'averagePercent', avg_pct, 'passRatePercent', pass_pct) ORDER BY title) FROM asm),
                          '[]'::jsonb),
            'atRiskCount', (SELECT n FROM risk),
            'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('day', day, 'activeLearners', active_learners,
                          'itemsCompleted', items_completed, 'submissions', submissions, 'attempts', attempts) ORDER BY day)
                          FROM recent), '[]'::jsonb))
           WHERE EXISTS (SELECT 1 FROM ok)) AS data`);
      const row = r.rows[0] as { acc?: unknown; data?: unknown } | undefined;
      return { acc: asAcc(row?.acc), data: (row?.data as Row | null) ?? null };
    },

    // ------------------------------------------------------------ instructor: all my offerings
    async teachingDashboard(tx: Executor, tenantId: string, userId: string): Promise<Row> {
      const t = T(tenantId);
      const r = await tx.execute(sql`
        WITH mine AS MATERIALIZED (
          SELECT p.offering_id AS oid, p.participation::text AS participation,
                 coalesce(o.title_override, c.title) AS title
            FROM lms.course_participants p
            JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id AND o.status = 'published'
            JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
           WHERE p.tenant_id = ${t} AND tm.user_id = ${userId}::uuid AND tm.status = 'active' AND p.status = 'active'
             AND p.participation IN ('instructor', 'assistant')),
        roll AS (
          SELECT r.offering_id AS oid, count(*) AS learners,
                 round(avg(100.0 * r.completed_required / r.total_required) FILTER (WHERE r.total_required > 0), 1) AS prog
            FROM lms.rollup_learner_offering r
           WHERE r.tenant_id = ${t} AND r.offering_id IN (SELECT oid FROM mine) GROUP BY r.offering_id),
        risk AS (
          SELECT f.offering_id AS oid, count(*) AS n
            FROM lms.atrisk_flags(${t}, now()) f
           WHERE f.offering_id IN (SELECT oid FROM mine) AND (f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive)
           GROUP BY f.offering_id),
        latest AS MATERIALIZED (
          SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.offering_id AS oid, s.assignment_item_id, s.participant_id
            FROM lms.submissions s
           WHERE s.tenant_id = ${t} AND s.offering_id IN (SELECT oid FROM mine)
           ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
        bs AS (SELECT l.oid, count(*) AS n FROM latest l
                WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g
                                   WHERE g.tenant_id = ${t} AND g.assignment_item_id = l.assignment_item_id
                                     AND g.participant_id = l.participant_id AND g.submission_id = l.id)
                GROUP BY l.oid),
        ba AS (SELECT x.offering_id AS oid, count(*) AS n FROM lms.attempts x
                WHERE x.tenant_id = ${t} AND x.offering_id IN (SELECT oid FROM mine) AND x.status = 'submitted'
                GROUP BY x.offering_id),
        nd AS (SELECT a.offering_id AS oid, min(a.due_at) AS at FROM lms.assignments a
                WHERE a.tenant_id = ${t} AND a.offering_id IN (SELECT oid FROM mine) AND a.due_at > now()
                GROUP BY a.offering_id)
        SELECT jsonb_build_object(
          'timeZone', lms.tenant_tz(${t}),
          'asOf', (SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${t} AND s.kind = 'learner'),
          'offerings', coalesce((SELECT jsonb_agg(jsonb_build_object(
              'offeringId', m.oid, 'title', m.title, 'participation', m.participation,
              'learners', coalesce(ro.learners, 0), 'averageProgressPercent', ro.prog,
              'backlogSubmissions', coalesce(bs.n, 0), 'backlogAttempts', coalesce(ba.n, 0),
              'atRiskCount', coalesce(rk.n, 0), 'nextDeadline', nd.at) ORDER BY m.title, m.oid)
            FROM mine m LEFT JOIN roll ro ON ro.oid = m.oid LEFT JOIN risk rk ON rk.oid = m.oid
            LEFT JOIN bs ON bs.oid = m.oid LEFT JOIN ba ON ba.oid = m.oid LEFT JOIN nd ON nd.oid = m.oid), '[]'::jsonb)) AS d`);
      return (r.rows[0] as { d: Row }).d;
    },

    // ------------------------------------------------------------ video drop-off
    async videoEngagement(
      tx: Executor,
      a: AccessSpec,
      itemId: string,
    ): Promise<{ acc: AccessRow | null; data: Row | null }> {
      const t = T(a.tenantId);
      const o = sql`${a.offeringId}::uuid`;
      const r = await tx.execute(sql`
        WITH ${accessCte(a)},
        ok AS (SELECT 1 AS v FROM acc WHERE acc.visible AND acc.allowed),
        it AS (
          SELECT i.id, i.title, greatest(1, va.duration_ms / 1000) AS dur
            FROM lms.content_items i
            JOIN lms.video_assets va ON va.tenant_id = i.tenant_id AND va.id = i.video_asset_id AND va.duration_ms IS NOT NULL
           WHERE i.tenant_id = ${t} AND i.offering_id = ${o} AND i.id = ${itemId}::uuid AND i.kind = 'video'
             AND i.deleted_at IS NULL AND EXISTS (SELECT 1 FROM ok)),
        lrn AS MATERIALIZED (
          SELECT p.id AS pid FROM lms.course_participants p
           WHERE p.tenant_id = ${t} AND p.offering_id = ${o} AND p.participation = 'learner' AND p.status = 'active'
             AND EXISTS (SELECT 1 FROM it)),
        pr AS MATERIALIZED (
          SELECT ip.ranges FROM lms.item_progress ip
           WHERE ip.tenant_id = ${t} AND ip.item_id = ${itemId}::uuid AND ip.participant_id IN (SELECT pid FROM lrn)),
        g AS (SELECT dur, least(60, dur) AS nseg, ceil(dur::numeric / least(60, dur))::int AS width FROM it),
        segs AS (
          SELECT s AS idx, s * g.width AS lo, least(g.dur, (s + 1) * g.width) AS hi
            FROM g, generate_series(0, (SELECT nseg FROM g) - 1) s
           WHERE s * g.width < g.dur),
        cover AS (
          SELECT sg.idx, sg.lo, sg.hi, count(pr.ranges) FILTER (WHERE pr.ranges @> ((sg.lo + sg.hi) / 2)::int) AS n
            FROM segs sg LEFT JOIN pr ON true GROUP BY sg.idx, sg.lo, sg.hi)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
          (SELECT jsonb_build_object('itemId', it.id, 'title', it.title, 'durationSeconds', it.dur,
             'learners', (SELECT count(*) FROM lrn), 'started', (SELECT count(*) FROM pr WHERE NOT isempty(pr.ranges)),
             'segments', coalesce((SELECT jsonb_agg(jsonb_build_object('fromSecond', lo, 'toSecond', hi,
                 'percent', CASE WHEN (SELECT count(*) FROM lrn) = 0 THEN 0
                            ELSE round(100.0 * n / (SELECT count(*) FROM lrn), 1) END) ORDER BY idx) FROM cover), '[]'::jsonb))
             FROM it) AS data`);
      const row = r.rows[0] as { acc?: unknown; data?: unknown } | undefined;
      return { acc: asAcc(row?.acc), data: (row?.data as Row | null) ?? null };
    },

    // ------------------------------------------------------------ at-risk page of one offering
    async atRiskPage(
      tx: Executor,
      a: AccessSpec,
      q: { limit: number; after: string | null },
    ): Promise<{
      acc: AccessRow | null;
      asOf: string | null;
      tz: string;
      settings: Row;
      total: number;
      rows: Row[];
    }> {
      const t = T(a.tenantId);
      const o = sql`${a.offeringId}::uuid`;
      const r = await tx.execute(sql`
        WITH ${accessCte(a)},
        ok AS (SELECT 1 AS v FROM acc WHERE acc.visible AND acc.allowed),
        st AS (SELECT lms.atrisk_settings(${t}) AS v),
        off AS (SELECT behind_after_days FROM lms.course_offerings WHERE tenant_id = ${t} AND id = ${o}),
        fl AS MATERIALIZED (
          SELECT f.* FROM lms.atrisk_flags(${t}, now()) f
           WHERE f.offering_id = ${o} AND EXISTS (SELECT 1 FROM ok)
             AND (f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive)),
        page AS MATERIALIZED (
          SELECT f.*, u.display_name, u.email, r.last_activity_at, r.enrolled_at, r.avg_score, r.scored_items, r.missed_deadlines
            FROM fl f
            JOIN lms.rollup_learner_offering r ON r.tenant_id = ${t} AND r.participant_id = f.participant_id
            JOIN lms.member_identity u ON u.tenant_id = ${t} AND u.user_id = f.user_id
           ${q.after ? sql`WHERE f.participant_id > ${q.after}::uuid` : sql``}
           ORDER BY f.participant_id LIMIT ${q.limit + 1}),
        vis AS MATERIALIZED (${visibleItems(a.tenantId, a.offeringId, true)}),
        behind AS (
          SELECT pg.participant_id AS pid,
                 jsonb_agg(jsonb_build_object('title', v.title, 'since', v.eff_open) ORDER BY v.eff_open, v.id) AS items
            FROM page pg JOIN vis v ON v.eff_open <= now() - make_interval(days => (SELECT behind_after_days FROM off)::int)
           WHERE pg.f_behind AND NOT EXISTS (SELECT 1 FROM lms.item_progress ip
                    WHERE ip.tenant_id = ${t} AND ip.participant_id = pg.participant_id AND ip.item_id = v.id AND ip.status = 'completed')
           GROUP BY pg.participant_id),
        missed AS (
          SELECT pg.participant_id AS pid, jsonb_agg(jsonb_build_object('title', m.title, 'at', m.at) ORDER BY m.at) AS items
            FROM page pg
            CROSS JOIN LATERAL (
              SELECT ci.title, coalesce(e.extended_due_at, a2.due_at) AS at
                FROM lms.assignments a2
                JOIN lms.content_items ci ON ci.tenant_id = a2.tenant_id AND ci.id = a2.item_id AND ci.deleted_at IS NULL AND ci.published
                LEFT JOIN lms.assignment_extensions e ON e.tenant_id = a2.tenant_id AND e.assignment_item_id = a2.item_id
                                                     AND e.participant_id = pg.participant_id
               WHERE a2.tenant_id = ${t} AND a2.offering_id = ${o} AND a2.due_at IS NOT NULL
                 AND coalesce(e.extended_due_at, a2.due_at) < now()
                 AND NOT EXISTS (SELECT 1 FROM lms.submissions s WHERE s.tenant_id = ${t}
                                  AND s.assignment_item_id = a2.item_id AND s.participant_id = pg.participant_id)
              UNION ALL
              SELECT ci.title, greatest(s.closes_at, coalesce(ac.extended_close_at, s.closes_at))
                FROM lms.assessments s
                JOIN lms.content_items ci ON ci.tenant_id = s.tenant_id AND ci.id = s.item_id AND ci.deleted_at IS NULL AND ci.published
                LEFT JOIN lms.assessment_accommodations ac ON ac.tenant_id = s.tenant_id AND ac.assessment_item_id = s.item_id
                                                          AND ac.participant_id = pg.participant_id
               WHERE s.tenant_id = ${t} AND s.offering_id = ${o} AND s.closes_at IS NOT NULL
                 AND greatest(s.closes_at, coalesce(ac.extended_close_at, s.closes_at)) < now()
                 AND NOT EXISTS (SELECT 1 FROM lms.attempts x WHERE x.tenant_id = ${t}
                                  AND x.assessment_item_id = s.item_id AND x.participant_id = pg.participant_id)) m
           WHERE pg.f_missed GROUP BY pg.participant_id),
        scores AS MATERIALIZED (
          SELECT f.participant_id AS pid, ci.title, round(f.score * 100 / f.max_score, 1) AS pct
            FROM lms.assignment_final_scores(${t}, ${o}) f
            JOIN lms.content_items ci ON ci.tenant_id = ${t} AND ci.id = f.item_id AND ci.deleted_at IS NULL
           WHERE f.released AND f.max_score > 0 AND f.participant_id IN (SELECT participant_id FROM page WHERE f_low)
          UNION ALL
          SELECT q2.participant_id, ci.title, round(q2.score * 100 / q2.max_score, 1)
            FROM lms.gradebook_assessment_scores(${t}, ${o}) q2
            JOIN lms.content_items ci ON ci.tenant_id = ${t} AND ci.id = q2.item_id AND ci.deleted_at IS NULL
           WHERE q2.released AND q2.max_score > 0 AND q2.participant_id IN (SELECT participant_id FROM page WHERE f_low)),
        sc AS (SELECT pid, jsonb_agg(jsonb_build_object('title', title, 'percent', pct) ORDER BY title) AS items FROM scores GROUP BY pid)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${t} AND s.kind = 'learner') AS as_of,
               lms.tenant_tz(${t}) AS tz, (SELECT v FROM st) AS settings,
               (SELECT count(*) FROM fl)::int AS total,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'participantId', pg.participant_id, 'displayName', pg.display_name, 'email', pg.email,
                  'behind', pg.f_behind, 'missed', pg.f_missed, 'low', pg.f_low, 'inactive', pg.f_inactive,
                  'behindItems', coalesce(b.items, '[]'::jsonb), 'missedItems', coalesce(m.items, '[]'::jsonb),
                  'scoreItems', coalesce(s.items, '[]'::jsonb), 'avgScore', pg.avg_score, 'scoredItems', pg.scored_items,
                  'missedCount', pg.missed_deadlines, 'lastActivityAt', pg.last_activity_at, 'enrolledAt', pg.enrolled_at)
                  ORDER BY pg.participant_id)
                FROM page pg LEFT JOIN behind b ON b.pid = pg.participant_id LEFT JOIN missed m ON m.pid = pg.participant_id
                LEFT JOIN sc s ON s.pid = pg.participant_id), '[]'::jsonb) AS rows`);
      const row = r.rows[0] as {
        acc?: unknown;
        as_of: string | null;
        tz: string;
        settings: Row;
        total: number;
        rows: Row[];
      };
      return {
        acc: asAcc(row.acc),
        asOf: row.as_of,
        tz: row.tz,
        settings: row.settings,
        total: Number(row.total),
        rows: row.rows,
      };
    },

    // ------------------------------------------------------------ college reports (institution admins)
    async asOf(tx: Executor, tenantId: string, kind: string): Promise<string | null> {
      const r = await tx.execute(
        sql`SELECT (SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${T(tenantId)} AND s.kind = ${kind}::text) AS a`,
      );
      const v = (r.rows[0] as { a: string | Date | null }).a;
      return v ? new Date(v).toISOString() : null;
    },

    async activeUsers(tx: Executor, tenantId: string): Promise<Row> {
      const t = T(tenantId);
      const r = await tx.execute(sql`
        WITH n AS (SELECT lms.local_day(now(), lms.tenant_tz(${t})) AS today)
        SELECT lms.tenant_tz(${t}) AS tz, (SELECT today FROM n)::text AS today,
          (SELECT count(*) FROM lms.member_activity_days d WHERE d.tenant_id = ${t} AND d.day = (SELECT today FROM n))::int AS dau,
          (SELECT count(DISTINCT d.user_id) FROM lms.member_activity_days d
            WHERE d.tenant_id = ${t} AND d.day > (SELECT today FROM n) - 7)::int AS wau,
          (SELECT count(DISTINCT d.user_id) FROM lms.member_activity_days d
            WHERE d.tenant_id = ${t} AND d.day > (SELECT today FROM n) - 30)::int AS mau,
          (SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${t} AND s.kind = 'tenant_day') AS as_of`);
      return r.rows[0] as Row;
    },

    /** The rows of one report table. Column definitions live in the service (one place, used by JSON and exports). */
    async reportRows(
      tx: Executor,
      tenantId: string,
      table: string,
      o: { scope: string; days: number },
    ): Promise<{ rows: Row[]; tz: string; asOf: string | null; weeks: number; disabled: boolean }> {
      const t = T(tenantId);
      // the course-health window is a college setting, read inside the same statement
      const weeks = sql`coalesce((SELECT (s.value ->> 'courseHealthWeeks')::int FROM lms.tenant_settings s
                                   WHERE s.tenant_id = ${t} AND s.key = 'analytics'), 3)`;
      const backlogDays = sql`coalesce((SELECT (s.value ->> 'courseHealthBacklogDays')::int FROM lms.tenant_settings s
                                         WHERE s.tenant_id = ${t} AND s.key = 'analytics'), 14)`;
      const showHealth = sql`coalesce((SELECT (s.value ->> 'showCourseHealth')::boolean FROM lms.tenant_settings s
                                        WHERE s.tenant_id = ${t} AND s.key = 'analytics'), true)`;
      const asOfKind =
        table === 'activity'
          ? 'tenant_day'
          : table === 'resources' || table === 'gradebooks' || table === 'grading-backlog'
            ? null
            : 'learner';
      const lim = REPORT_ROW_LIMIT + 1;
      let q: SQL;
      switch (table) {
        case 'activity':
          q = sql`
            SELECT g::date::text AS day, coalesce(r.active_users, 0)::int AS active_users,
                   coalesce(r.active_learners, 0)::int AS active_learners,
                   round(coalesce(r.video_seconds, 0) / 60.0, 1)::float8 AS video_minutes
              FROM generate_series((lms.local_day(now(), lms.tenant_tz(${t})) - ${o.days}::int + 1)::timestamp,
                                   lms.local_day(now(), lms.tenant_tz(${t}))::timestamp, interval '1 day') g
              LEFT JOIN lms.rollup_tenant_day r ON r.tenant_id = ${t} AND r.day = g::date
             ORDER BY g`;
          break;
        case 'organisation': {
          const node: Record<string, SQL> = {
            department: sql`SELECT d.id, d.name AS label FROM lms.departments d WHERE d.tenant_id = ${t}`,
            program: sql`SELECT p.id, p.name AS label FROM lms.programs p WHERE p.tenant_id = ${t}`,
            batch: sql`SELECT b.id, pr.name || ' ' || b.admission_year AS label FROM lms.batches b
                         JOIN lms.programs pr ON pr.tenant_id = b.tenant_id AND pr.id = b.program_id WHERE b.tenant_id = ${t}`,
            section: sql`SELECT s.id, s.code AS label FROM lms.sections s WHERE s.tenant_id = ${t}`,
          };
          const col: Record<string, SQL> = {
            department: sql`mp.department_id`,
            program: sql`b.program_id`,
            batch: sql`mp.batch_id`,
            section: sql`mp.section_id`,
          };
          // per learner FIRST (one row each, no DISTINCT over 50,000 enrolments), then the group they belong to
          q = sql`
            WITH nodes AS (${node[o.scope] ?? node.department}),
            flags AS MATERIALIZED (
              SELECT f.participant_id, (f.f_behind OR f.f_missed OR f.f_low OR f.f_inactive) AS flagged
                FROM lms.atrisk_flags(${t}, now()) f),
            per_user AS MATERIALIZED (
              SELECT r.user_id, count(*)::int AS enr,
                     coalesce(sum(100.0 * r.completed_required / r.total_required) FILTER (WHERE r.total_required > 0), 0) AS comp_sum,
                     (count(*) FILTER (WHERE r.total_required > 0))::int AS comp_n,
                     coalesce(sum(r.avg_score) FILTER (WHERE r.avg_score IS NOT NULL), 0) AS score_sum,
                     (count(*) FILTER (WHERE r.avg_score IS NOT NULL))::int AS score_n,
                     bool_or(coalesce(fl.flagged, false)) AS flagged
                FROM lms.rollup_learner_offering r
                LEFT JOIN flags fl ON fl.participant_id = r.participant_id
               WHERE r.tenant_id = ${t}
               GROUP BY r.user_id),
            prof AS MATERIALIZED (
              SELECT tm.user_id, ${col[o.scope] ?? col.department} AS node
                FROM lms.tenant_memberships tm
                JOIN lms.member_profiles mp ON mp.tenant_id = tm.tenant_id AND mp.membership_id = tm.id
                LEFT JOIN lms.batches b ON b.tenant_id = mp.tenant_id AND b.id = mp.batch_id
               WHERE tm.tenant_id = ${t}),
            m AS (SELECT pr.node, u.* FROM per_user u JOIN prof pr ON pr.user_id = u.user_id)
            SELECT n.label AS name, count(m.user_id)::int AS learners, coalesce(sum(m.enr), 0)::int AS enrolments,
                   CASE WHEN coalesce(sum(m.comp_n), 0) = 0 THEN NULL ELSE round(sum(m.comp_sum) / sum(m.comp_n), 1)::float8 END AS avg_completion,
                   CASE WHEN coalesce(sum(m.score_n), 0) = 0 THEN NULL ELSE round(sum(m.score_sum) / sum(m.score_n), 1)::float8 END AS avg_score,
                   (count(m.user_id) FILTER (WHERE m.flagged))::int AS flagged_learners
              FROM nodes n LEFT JOIN m ON m.node = n.id
             GROUP BY n.id, n.label ORDER BY n.label`;
          break;
        }
        case 'course-health':
          // "Needs attention": offerings whose CONTENT has not changed for N weeks or whose oldest ungraded work has waited longer than D
          // days. About the upkeep of a course, never about a person. Every source is aggregated ONCE per offering.
          q = sql`
            WITH n AS (SELECT lms.local_day(now(), lms.tenant_tz(${t})) AS today),
            offs AS MATERIALIZED (
              SELECT o.id AS oid, o.tenant_id, c.code, coalesce(o.title_override, c.title) AS title, tm.name AS term
                FROM lms.course_offerings o
                JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
                JOIN lms.terms tm ON tm.tenant_id = o.tenant_id AND tm.id = o.term_id
               WHERE o.tenant_id = ${t} AND o.status = 'published' AND ${showHealth}
                 AND tm.end_date >= (SELECT today FROM n) AND tm.start_date <= (SELECT today FROM n)),
            lrn AS (SELECT p.offering_id AS oid, count(*)::int AS learners FROM lms.course_participants p
                     WHERE p.tenant_id = ${t} AND p.participation = 'learner' AND p.status = 'active' GROUP BY p.offering_id),
            ci AS (SELECT i.offering_id AS oid, max(greatest(i.created_at, i.updated_at)) AS last_content
                     FROM lms.content_items i WHERE i.tenant_id = ${t} AND i.deleted_at IS NULL GROUP BY i.offering_id),
            latest AS MATERIALIZED (
              SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.offering_id, s.assignment_item_id, s.participant_id, s.submitted_at
                FROM lms.submissions s
               WHERE s.tenant_id = ${t} AND s.offering_id IN (SELECT oid FROM offs)
               ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
            waiting AS (
              SELECT l.offering_id AS oid, l.submitted_at AS since FROM latest l
               WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g WHERE g.tenant_id = ${t} AND g.assignment_item_id = l.assignment_item_id
                                   AND g.participant_id = l.participant_id AND g.submission_id = l.id)
              UNION ALL
              SELECT x.offering_id, x.submitted_at FROM lms.attempts x
               WHERE x.tenant_id = ${t} AND x.status = 'submitted' AND x.offering_id IN (SELECT oid FROM offs)),
            wt AS (SELECT oid, min(since) AS oldest FROM waiting GROUP BY oid),
            f AS (
              SELECT b.*, coalesce(lrn.learners, 0) AS learners, ci.last_content, wt.oldest
                FROM offs b LEFT JOIN lrn ON lrn.oid = b.oid LEFT JOIN ci ON ci.oid = b.oid LEFT JOIN wt ON wt.oid = b.oid),
            g AS (
              SELECT f.*,
                     (f.last_content IS NULL OR f.last_content < now() - make_interval(weeks => ${weeks})) AS stale_content,
                     (f.oldest IS NOT NULL AND f.oldest < now() - make_interval(days => ${backlogDays})) AS old_backlog
                FROM f)
            SELECT code AS course_code, title AS course, term, learners,
                   CASE WHEN last_content IS NULL THEN NULL ELSE floor(extract(epoch FROM now() - last_content) / 604800)::int END AS weeks_since_content,
                   CASE WHEN oldest IS NULL THEN NULL ELSE floor(extract(epoch FROM now() - oldest) / 86400)::int END AS oldest_waiting_days,
                   concat_ws('; ', CASE WHEN stale_content THEN 'No new content in ' || ${weeks} || ' weeks' END,
                                   CASE WHEN old_backlog THEN 'Grading backlog older than ' || ${backlogDays} || ' days' END) AS attention
              FROM g WHERE stale_content OR old_backlog ORDER BY title, oid`;
          break;
        case 'gradebooks':
          q = sql`
            WITH n AS (SELECT lms.local_day(now(), lms.tenant_tz(${t})) AS today)
            SELECT c.code AS course_code, coalesce(o.title_override, c.title) AS course, tm.name AS term,
                   coalesce(g.status, 'not_started') AS status, g.version_no AS version, g.submitted_at AS submitted_at,
                   (SELECT count(*) FROM lms.course_participants p WHERE p.tenant_id = o.tenant_id AND p.offering_id = o.id
                       AND p.participation = 'learner' AND p.status = 'active')::int AS learners
              FROM lms.course_offerings o
              JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
              JOIN lms.terms tm ON tm.tenant_id = o.tenant_id AND tm.id = o.term_id
              LEFT JOIN lms.gradebooks g ON g.tenant_id = o.tenant_id AND g.offering_id = o.id
             WHERE o.tenant_id = ${t} AND o.status IN ('published', 'archived')
               AND tm.end_date >= (SELECT today FROM n) - 120 AND tm.start_date <= (SELECT today FROM n)
             ORDER BY tm.name, c.code, o.id LIMIT ${lim}`;
          break;
        case 'grading-backlog':
          q = sql`
            WITH latest AS MATERIALIZED (
              SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.offering_id, s.assignment_item_id, s.participant_id, s.submitted_at
                FROM lms.submissions s JOIN lms.course_offerings o ON o.tenant_id = s.tenant_id AND o.id = s.offering_id AND o.status = 'published'
               WHERE s.tenant_id = ${t} ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
            w AS (
              SELECT l.offering_id AS oid, 1 AS sub, 0 AS att, l.submitted_at AS since FROM latest l
               WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g WHERE g.tenant_id = ${t} AND g.assignment_item_id = l.assignment_item_id
                                   AND g.participant_id = l.participant_id AND g.submission_id = l.id)
              UNION ALL
              SELECT x.offering_id, 0, 1, x.submitted_at FROM lms.attempts x
                JOIN lms.course_offerings o ON o.tenant_id = x.tenant_id AND o.id = x.offering_id AND o.status = 'published'
               WHERE x.tenant_id = ${t} AND x.status = 'submitted')
            SELECT c.code AS course_code, coalesce(o.title_override, c.title) AS course, sum(w.sub)::int AS submissions,
                   sum(w.att)::int AS attempts, min(w.since) AS oldest_waiting
              FROM w JOIN lms.course_offerings o ON o.tenant_id = ${t} AND o.id = w.oid
              JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
             GROUP BY c.code, o.id, o.title_override, c.title ORDER BY sum(w.sub) + sum(w.att) DESC, c.code LIMIT ${lim}`;
          break;
        case 'at-risk':
          q = sql`
            WITH fl AS MATERIALIZED (
              SELECT f.user_id, bool_or(f.f_behind) AS b, bool_or(f.f_missed) AS m, bool_or(f.f_low) AS l, bool_or(f.f_inactive) AS i
                FROM lms.atrisk_flags(${t}, now()) f GROUP BY f.user_id),
            prof AS MATERIALIZED (
              SELECT tm.user_id, mp.department_id
                FROM lms.tenant_memberships tm
                JOIN lms.member_profiles mp ON mp.tenant_id = tm.tenant_id AND mp.membership_id = tm.id
               WHERE tm.tenant_id = ${t})
            SELECT coalesce(d.name, '(no department)') AS department,
                   (count(*) FILTER (WHERE fl.b OR fl.m OR fl.l OR fl.i))::int AS flagged_learners,
                   (count(*) FILTER (WHERE fl.b))::int AS behind,
                   (count(*) FILTER (WHERE fl.m))::int AS missed_deadlines,
                   (count(*) FILTER (WHERE fl.l))::int AS low_score,
                   (count(*) FILTER (WHERE fl.i))::int AS inactive,
                   count(*)::int AS learners
              FROM fl
              LEFT JOIN prof ON prof.user_id = fl.user_id
              LEFT JOIN lms.departments d ON d.tenant_id = ${t} AND d.id = prof.department_id
             GROUP BY d.id, d.name ORDER BY d.name NULLS LAST`;
          break;
        case 'resources':
          q = sql`
            WITH n AS (SELECT lms.local_day(now(), lms.tenant_tz(${t})) AS today)
            SELECT metric, value::float8 AS value, unit FROM (VALUES
              (1, 'Storage in use (files, video, sources)', round(lms.tenant_storage_bytes(${t}) / 1000000000.0, 3), 'GB'),
              (2, 'Video watched, last 30 days',
                 (SELECT round(coalesce(sum(w.seconds), 0) / 60.0, 1) FROM lms.video_watch_days w
                   WHERE w.tenant_id = ${t} AND w.day > (SELECT today FROM n) - 30), 'minutes'),
              (3, 'Video watched, this month',
                 (SELECT round(coalesce(sum(w.seconds), 0) / 60.0, 1) FROM lms.video_watch_days w
                   WHERE w.tenant_id = ${t} AND w.day >= date_trunc('month', (SELECT today FROM n))::date), 'minutes'),
              (4, 'Videos ready', (SELECT count(*) FROM lms.video_assets v WHERE v.tenant_id = ${t} AND v.status = 'ready'), 'videos'),
              (5, 'Files stored', (SELECT count(*) FROM lms.files f WHERE f.tenant_id = ${t} AND f.status = 'ready'), 'files')
            ) AS x (ord, metric, value, unit) ORDER BY ord`;
          break;
        default:
          return { rows: [], tz: '', asOf: null, weeks: 3, disabled: false };
      }
      const asOf = asOfKind
        ? sql`(SELECT s.as_of FROM lms.rollup_state s WHERE s.tenant_id = ${t} AND s.kind = ${asOfKind}::text)`
        : sql`NULL::timestamptz`;
      const r = await tx.execute(sql`
        SELECT coalesce(jsonb_agg(to_jsonb(x) - 'ord' ORDER BY x.ord), '[]'::jsonb) AS rows,
               lms.tenant_tz(${t}) AS tz, ${asOf} AS as_of, ${weeks} AS weeks, NOT ${showHealth} AS health_off
          FROM (SELECT row_number() OVER () AS ord, y.* FROM (${q}) y) x`);
      const row = r.rows[0] as {
        rows: Row[];
        tz: string;
        as_of: string | Date | null;
        weeks: number;
        health_off: boolean;
      };
      return {
        rows: row.rows,
        tz: row.tz,
        asOf: row.as_of ? new Date(row.as_of).toISOString() : null,
        weeks: Number(row.weeks),
        disabled: table === 'course-health' && row.health_off === true,
      };
    },
  };
}
export type AnalyticsRepository = ReturnType<typeof createAnalyticsRepository>;

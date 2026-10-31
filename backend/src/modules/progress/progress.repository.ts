import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { type AccessRow, type AccessSpec, accessCte } from '../courses';

// SQL only. Writes are ONE call of a SECURITY DEFINER function (the heartbeat, mark done); reads are one statement each
// (the access CTE decides who may read in the same statement). Percentages are computed from indexed aggregates when
// they are read: a learner's rows are found by the primary key (tenant, participant, item), a class by the offering.
export type Row = Record<string, unknown>;

const asAcc = (v: unknown): AccessRow | null => (v as AccessRow | null) ?? null;

/** The items a learner can see right now: published, in a published module, not archived, not locked. */
const visibleItems = (tenantId: string, offeringId: string, requiredOnly: boolean): SQL => sql`
  SELECT i.id, i.module_id, i.title, i.kind, i.required, i.completion,
         greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at) AS eff_open
    FROM lms.content_items i
    JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
   WHERE i.tenant_id = ${tenantId}::uuid AND i.offering_id = ${offeringId}::uuid
     AND i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published
     AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()
     ${requiredOnly ? sql`AND i.required` : sql``}`;

const modulesOf = (tenantId: string, offeringId: string): SQL => sql`
  SELECT m.id, m.title, m.position FROM lms.content_modules m
   WHERE m.tenant_id = ${tenantId}::uuid AND m.offering_id = ${offeringId}::uuid
     AND m.deleted_at IS NULL AND m.published`;

const watchedPercent = sql`CASE WHEN pr.duration_s > 0 THEN least(100, (pr.watched_seconds * 100) / pr.duration_s) ELSE 0 END`;

export interface HeartbeatInput {
  tenantId: string;
  userId: string;
  offeringId: string;
  itemId: string;
  videoId: string;
  streamId: string;
  seq: number;
  /** a validated multirange literal such as '{[10,40)}' */
  ranges: string;
  position: number;
  rate: number;
}

export type ClassSort = 'name' | 'percent' | 'activity';
export interface ClassQuery {
  limit: number;
  /** keyset position: the sort value and the participant id of the last row of the previous page */
  after: { key: string | number; id: string } | null;
  section: string | null;
  status: 'not_started' | 'in_progress' | 'behind' | 'completed' | null;
  removed: boolean;
  sort: ClassSort;
  dir: 'asc' | 'desc';
}

/** The class page as ONE statement (exported so the benchmark can EXPLAIN it). */
export function classPageStatement(a: AccessSpec, q: ClassQuery): SQL {
  const t = sql`${a.tenantId}::uuid`;
  const o = sql`${a.offeringId}::uuid`;
  const key = {
    name: sql`lower(q.display_name)`,
    percent: sql`coalesce(q.percent, -1)`,
    activity: sql`coalesce(extract(epoch FROM q.last_activity_at), -1)`,
  }[q.sort];
  const cast = q.sort === 'name' ? sql`::text` : sql`::numeric`;
  const cmp = q.dir === 'asc' ? sql`>` : sql`<`;
  const order = q.dir === 'asc' ? sql`ASC` : sql`DESC`;
  const after = q.after
    ? sql`AND (${key}, q.pid) ${cmp} (${String(q.after.key)}${cast}, ${q.after.id}::uuid)`
    : sql``;
  const status = {
    completed: sql`AND q.is_completed`,
    behind: sql`AND q.is_behind`,
    not_started: sql`AND NOT q.touched AND NOT q.is_completed`,
    in_progress: sql`AND q.touched AND NOT q.is_completed AND NOT q.is_behind`,
  };
  const filter = q.status ? status[q.status] : sql``;
  return sql`
    WITH ${accessCte(a)},
    settings AS (SELECT behind_after_days FROM lms.course_offerings WHERE tenant_id = ${t} AND id = ${o}),
    vis AS (${visibleItems(a.tenantId, a.offeringId, true)}),
    mods AS (${modulesOf(a.tenantId, a.offeringId)}),
    parts AS MATERIALIZED (
      SELECT p.id AS pid, u.id AS user_id, u.display_name, u.email, s.code AS section_name, p.status = 'removed' AS removed
        FROM lms.course_participants p
        JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
        JOIN lms.users u ON u.id = tm.user_id
        LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
        LEFT JOIN lms.sections s ON s.tenant_id = mp.tenant_id AND s.id = mp.section_id
       WHERE p.tenant_id = ${t} AND p.offering_id = ${o} AND p.participation = 'learner'
         AND p.status = ${q.removed ? sql`'removed'` : sql`'active'`}::lms.participant_status
         ${q.section ? sql`AND mp.section_id = ${q.section}::uuid` : sql``}
         AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)),
    cutoff AS (SELECT now() - make_interval(days => (SELECT behind_after_days FROM settings)::int) AS at),
    done AS (
      SELECT ip.participant_id AS pid, v.module_id,
             count(*)::int AS c,
             count(*) FILTER (WHERE v.eff_open <= (SELECT at FROM cutoff))::int AS c_due
        FROM lms.item_progress ip
        JOIN vis v ON v.id = ip.item_id
       WHERE ip.tenant_id = ${t} AND ip.offering_id = ${o} AND ip.status = 'completed'
       GROUP BY ip.participant_id, v.module_id),
    -- ONE row per learner: the totals and a {moduleId: completed} object. Everything after this joins ONE row per
    -- learner (never one per module), and a module's share is a key lookup in the object, not a scan of "done".
    done_m AS MATERIALIZED (
      SELECT d.pid, sum(d.c)::int AS c, sum(d.c_due)::int AS c_due,
             jsonb_object_agg(d.module_id, d.c) AS by_module
        FROM done d GROUP BY d.pid),
    touched AS MATERIALIZED (
      SELECT ip.participant_id AS pid, max(ip.last_activity_at) AS last_at
        FROM lms.item_progress ip
       WHERE ip.tenant_id = ${t} AND ip.offering_id = ${o}
       GROUP BY ip.participant_id),
    totals AS (
      SELECT (SELECT count(*) FROM vis)::int AS n,
             (SELECT count(*) FROM vis WHERE eff_open <= (SELECT at FROM cutoff))::int AS n_due),
    modtot AS MATERIALIZED (
      SELECT m.id, m.position, coalesce(c.n, 0)::int AS n
        FROM mods m LEFT JOIN (SELECT module_id, count(*) AS n FROM vis GROUP BY module_id) c ON c.module_id = m.id),
    q AS (
      SELECT pa.pid, pa.user_id, pa.display_name, pa.email, pa.section_name, pa.removed,
             totals.n AS total_required,
             coalesce(dm.c, 0) AS completed_required,
             coalesce(dm.c_due, 0) AS completed_due,
             totals.n_due AS due_total,
             (th.pid IS NOT NULL) AS touched, th.last_at AS last_activity_at,
             CASE WHEN totals.n = 0 THEN NULL ELSE round(100.0 * coalesce(dm.c, 0) / totals.n)::int END AS percent,
             coalesce(dm.by_module, '{}'::jsonb) AS by_module
        FROM parts pa
        CROSS JOIN totals
        LEFT JOIN done_m dm ON dm.pid = pa.pid
        LEFT JOIN touched th ON th.pid = pa.pid),
    q2 AS (
      SELECT q.*,
             (q.total_required > 0 AND q.completed_required >= q.total_required) AS is_completed,
             (NOT (q.total_required > 0 AND q.completed_required >= q.total_required)
              AND q.due_total > q.completed_due) AS is_behind
        FROM q),
    -- the page first (sort, keyset, limit), THEN the per-module shares for those rows only
    page AS (
      SELECT q.*, ${key} AS sort_key
        FROM q2 q WHERE true ${filter} ${after}
       ORDER BY ${key} ${order}, q.pid ${order}
       LIMIT ${q.limit + 1}),
    -- MATERIALIZED on purpose: a college without statistics makes the planner think "page" has one row, inline this
    -- step and run it once per page row (measured: 1,000 ms instead of 60). Computed once, whatever the estimates say.
    pm AS MATERIALIZED (
      SELECT pg.pid,
             jsonb_agg(jsonb_build_object('moduleId', mt.id,
                       'percent', CASE WHEN mt.n = 0 THEN NULL
                                       ELSE round(100.0 * coalesce((pg.by_module ->> mt.id::text)::int, 0) / mt.n)::int END)
                       ORDER BY mt.position COLLATE "C") AS modules
        FROM page pg CROSS JOIN modtot mt GROUP BY pg.pid)
    SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
           coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title) ORDER BY m.position COLLATE "C")
                       FROM mods m), '[]'::jsonb) AS modules,
           (SELECT count(*) FROM q2 q WHERE true ${filter})::int AS total,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                        'participantId', pg.pid, 'userId', pg.user_id, 'displayName', pg.display_name, 'email', pg.email,
                        'sectionName', pg.section_name, 'removed', pg.removed,
                        'completedRequired', pg.completed_required, 'totalRequired', pg.total_required,
                        'percent', pg.percent,
                        'status', CASE WHEN pg.is_completed THEN 'completed' WHEN pg.is_behind THEN 'behind'
                                       WHEN NOT pg.touched THEN 'not_started' ELSE 'in_progress' END,
                        'lastActivityAt', pg.last_activity_at,
                        'sortKey', pg.sort_key,
                        'modules', coalesce(pm.modules, '[]'::jsonb))
                    ORDER BY pg.sort_key ${order}, pg.pid ${order})
               FROM page pg LEFT JOIN pm ON pm.pid = pg.pid), '[]'::jsonb) AS rows`;
}

export function createProgressRepository() {
  return {
    /** The heartbeat: one call, one round trip (autocommit connection, no transaction). */
    async heartbeat(conn: Executor, h: HeartbeatInput): Promise<Row> {
      const res = await conn.execute(sql`
        SELECT * FROM lms.progress_heartbeat(
          ${h.tenantId}::uuid, ${h.userId}::uuid, ${h.offeringId}::uuid, ${h.itemId}::uuid, ${h.videoId}::uuid,
          ${h.streamId}::uuid, ${h.seq}::int, ${h.ranges}::text, ${h.position}::int, ${h.rate}::numeric)`);
      return (res.rows[0] ?? { result: 'no_offering' }) as Row;
    },

    /** Opened / marked done / undone: one call, one round trip. */
    async mark(
      conn: Executor,
      m: { tenantId: string; userId: string; offeringId: string; itemId: string; action: string },
    ): Promise<Row> {
      const res = await conn.execute(sql`
        SELECT * FROM lms.progress_mark(${m.tenantId}::uuid, ${m.userId}::uuid, ${m.offeringId}::uuid,
                                        ${m.itemId}::uuid, ${m.action}::text)`);
      return (res.rows[0] ?? { result: 'no_offering', status: 'not_started' }) as Row;
    },

    /** The caller's own progress in one offering, and where to continue. */
    async mine(tx: Executor, a: AccessSpec): Promise<{ acc: AccessRow | null; data: Row | null }> {
      const t = sql`${a.tenantId}::uuid`;
      const o = sql`${a.offeringId}::uuid`;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        me AS (
          SELECT p.id FROM lms.course_participants p
            JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
           WHERE p.tenant_id = ${t} AND p.offering_id = ${o} AND tm.user_id = ${a.userId}::uuid
             AND p.participation = 'learner' AND p.status = 'active'
           LIMIT 1),
        vis AS (${visibleItems(a.tenantId, a.offeringId, false)}),
        pr AS (
          SELECT ip.item_id, ip.status, ip.watched_seconds, ip.duration_s, ip.position_s, ip.last_activity_at
            FROM lms.item_progress ip
           WHERE ip.tenant_id = ${t} AND ip.offering_id = ${o} AND ip.participant_id = (SELECT id FROM me)),
        its AS (
          SELECT v.id, v.module_id, v.title, v.kind, v.required, coalesce(pr.status, 'not_started') AS st,
                 CASE WHEN v.kind = 'video' THEN ${watchedPercent} END AS wp,
                 CASE WHEN v.kind = 'video' THEN pr.position_s END AS pos, pr.last_activity_at
            FROM vis v LEFT JOIN pr ON pr.item_id = v.id
           WHERE EXISTS (SELECT 1 FROM me)),
        mods AS (${modulesOf(a.tenantId, a.offeringId)})
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
          jsonb_build_object(
            'participant', EXISTS (SELECT 1 FROM me),
            'totalRequired', (SELECT count(*) FROM its WHERE required),
            'completedRequired', (SELECT count(*) FROM its WHERE required AND st = 'completed'),
            'modules', coalesce((
              SELECT jsonb_agg(jsonb_build_object('moduleId', m.id, 'totalRequired', x.tot, 'completedRequired', x.done,
                      'percent', CASE WHEN x.tot = 0 THEN NULL ELSE round(100.0 * x.done / x.tot)::int END)
                      ORDER BY m.position COLLATE "C")
                FROM mods m
                CROSS JOIN LATERAL (
                  SELECT count(*) FILTER (WHERE its.required)::int AS tot,
                         count(*) FILTER (WHERE its.required AND its.st = 'completed')::int AS done
                    FROM its WHERE its.module_id = m.id) x), '[]'::jsonb),
            'items', coalesce((
              SELECT jsonb_agg(jsonb_build_object('itemId', id, 'moduleId', module_id, 'status', st,
                      'required', required, 'watchedPercent', wp, 'positionSeconds', pos)) FROM its), '[]'::jsonb),
            'resume', (
              SELECT jsonb_build_object('offeringId', ${o}, 'offeringTitle',
                       (SELECT coalesce(of.title_override, c.title) FROM lms.course_offerings of
                          JOIN lms.courses c ON c.tenant_id = of.tenant_id AND c.id = of.course_id
                         WHERE of.tenant_id = ${t} AND of.id = ${o}),
                       'itemId', id, 'itemTitle', title, 'kind', kind, 'positionSeconds', coalesce(pos, 0),
                       'lastActivityAt', last_activity_at)
                FROM its WHERE st = 'in_progress' ORDER BY last_activity_at DESC LIMIT 1)) AS data`);
      const r = res.rows[0];
      return { acc: asAcc(r?.acc), data: (r?.data as Row | null) ?? null };
    },

    /** "My courses": the percentage of every course the caller learns in, and where to continue. */
    async mineEverywhere(tx: Executor, tenantId: string, userId: string): Promise<Row> {
      const t = sql`${tenantId}::uuid`;
      const res = await tx.execute(sql`
        WITH mine AS (
          SELECT p.id AS pid, p.offering_id, coalesce(o.title_override, c.title) AS title
            FROM lms.course_participants p
            JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
            JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
           WHERE p.tenant_id = ${t} AND tm.user_id = ${userId}::uuid AND p.participation = 'learner'
             AND p.status = 'active' AND o.status = 'published'
           ORDER BY p.id LIMIT 100),
        vis AS (
          SELECT mine.pid, mine.offering_id, i.id, i.required, i.title, i.kind
            FROM mine
            JOIN lms.content_items i ON i.tenant_id = ${t} AND i.offering_id = mine.offering_id
            JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
           WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published
             AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()),
        its AS (
          SELECT v.*, coalesce(ip.status, 'not_started') AS st, ip.position_s, ip.last_activity_at
            FROM vis v
            LEFT JOIN lms.item_progress ip ON ip.tenant_id = ${t} AND ip.participant_id = v.pid AND ip.item_id = v.id)
        SELECT
          coalesce((SELECT jsonb_agg(jsonb_build_object('offeringId', mine.offering_id,
                  'totalRequired', x.tot, 'completedRequired', x.done,
                  'percent', CASE WHEN x.tot = 0 THEN NULL ELSE round(100.0 * x.done / x.tot)::int END))
              FROM mine CROSS JOIN LATERAL (
                SELECT count(*) FILTER (WHERE its.required)::int AS tot,
                       count(*) FILTER (WHERE its.required AND its.st = 'completed')::int AS done
                  FROM its WHERE its.pid = mine.pid) x), '[]'::jsonb) AS offerings,
          (SELECT jsonb_build_object('offeringId', its.offering_id,
                    'offeringTitle', (SELECT title FROM mine WHERE mine.pid = its.pid),
                    'itemId', its.id, 'itemTitle', its.title, 'kind', its.kind,
                    'positionSeconds', coalesce(its.position_s, 0), 'lastActivityAt', its.last_activity_at)
             FROM its WHERE its.st = 'in_progress' ORDER BY its.last_activity_at DESC LIMIT 1) AS resume`);
      return (res.rows[0] ?? { offerings: [], resume: null }) as Row;
    },

    /**
     * The class table: every learner of the offering with their percentage per module and overall, filtered, sorted and
     * keyset-paged. One statement: the visible required items (one index range scan), the learners, and the completed
     * counts from the progress of the offering (one range scan of item_progress_offering_idx), joined by hash.
     */
    async classPage(
      tx: Executor,
      a: AccessSpec,
      q: ClassQuery,
    ): Promise<{ acc: AccessRow | null; modules: Row[]; rows: Row[]; total: number }> {
      const res = await tx.execute(classPageStatement(a, q));
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        modules: (r?.modules as Row[] | undefined) ?? [],
        rows: (r?.rows as Row[] | undefined) ?? [],
        total: Number(r?.total ?? 0),
      };
    },

    /** One learner: every visible item with status, watched share and last activity. */
    async drilldown(
      tx: Executor,
      a: AccessSpec,
      participantId: string,
    ): Promise<{ acc: AccessRow | null; learner: Row | null; items: Row[] }> {
      const t = sql`${a.tenantId}::uuid`;
      const o = sql`${a.offeringId}::uuid`;
      const res = await tx.execute(sql`
        WITH ${accessCte(a)},
        who AS (
          SELECT p.id, u.display_name, u.email, p.status = 'removed' AS removed
            FROM lms.course_participants p
            JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            JOIN lms.users u ON u.id = tm.user_id
           WHERE p.tenant_id = ${t} AND p.offering_id = ${o} AND p.id = ${participantId}::uuid
             AND p.participation = 'learner' AND EXISTS (SELECT 1 FROM acc WHERE acc.visible AND acc.allowed)),
        vis AS (${visibleItems(a.tenantId, a.offeringId, false)}),
        its AS (
          SELECT v.id, v.module_id, v.title, v.kind, v.required,
                 coalesce(pr.status, CASE WHEN pr.item_id IS NULL THEN 'not_started' END, 'in_progress') AS st,
                 CASE WHEN v.kind = 'video' THEN ${watchedPercent} END AS wp,
                 CASE WHEN v.kind = 'video' THEN pr.watched_seconds END AS ws,
                 CASE WHEN v.kind = 'video' THEN pr.duration_s END AS ds,
                 pr.completed_at, pr.completed_how, pr.last_activity_at, coalesce(pr.suspicious, 0) AS flagged,
                 (SELECT m.title FROM lms.content_modules m WHERE m.tenant_id = ${t} AND m.id = v.module_id) AS module_title,
                 (SELECT m.position FROM lms.content_modules m WHERE m.tenant_id = ${t} AND m.id = v.module_id) AS mpos
            FROM vis v
            LEFT JOIN lms.item_progress pr ON pr.tenant_id = ${t} AND pr.participant_id = ${participantId}::uuid
                                          AND pr.item_id = v.id)
        SELECT (SELECT to_jsonb(acc) FROM acc) AS acc,
               (SELECT jsonb_build_object('participantId', who.id, 'displayName', who.display_name, 'email', who.email,
                         'removed', who.removed,
                         'totalRequired', (SELECT count(*) FROM its WHERE required),
                         'completedRequired', (SELECT count(*) FROM its WHERE required AND st = 'completed'))
                  FROM who) AS learner,
               coalesce((SELECT jsonb_agg(jsonb_build_object('itemId', id, 'moduleId', module_id, 'moduleTitle', module_title,
                         'title', title, 'kind', kind, 'required', required, 'status', st, 'watchedPercent', wp,
                         'watchedSeconds', ws, 'durationSeconds', ds, 'completedAt', completed_at,
                         'completedHow', completed_how, 'lastActivityAt', last_activity_at, 'flagged', flagged)
                         ORDER BY mpos COLLATE "C", title)
                 FROM its WHERE EXISTS (SELECT 1 FROM who)), '[]'::jsonb) AS items`);
      const r = res.rows[0];
      return {
        acc: asAcc(r?.acc),
        learner: (r?.learner as Row | null) ?? null,
        items: (r?.items as Row[] | undefined) ?? [],
      };
    },
  };
}
export type ProgressRepository = ReturnType<typeof createProgressRepository>;

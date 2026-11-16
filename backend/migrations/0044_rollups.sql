-- Step 12, part 2: the rollup refresh. Everything here is a hardened SECURITY DEFINER function (the worker has no tenant
-- context). A refresh RECOMPUTES the affected keys from the source tables (never applies deltas), so running it twice, or in any
-- order, gives the same rows. p_now is a parameter so tests can control the clock.

-- ------------------------------------------------------------------ storage gauge: files + video outputs + video sources
CREATE FUNCTION lms.tenant_storage_bytes(p_tenant uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT (SELECT coalesce(sum(f.size_bytes), 0) FROM lms.files f WHERE f.tenant_id = p_tenant AND f.status = 'ready')
       + (SELECT coalesce(sum((SELECT coalesce(sum((r ->> 'bytes')::bigint), 0) FROM jsonb_array_elements(v.renditions) r)
                              + CASE WHEN v.source_key IS NOT NULL THEN v.upload_offset ELSE 0 END), 0)
            FROM lms.video_assets v WHERE v.tenant_id = p_tenant)
$$;
REVOKE ALL ON FUNCTION lms.tenant_storage_bytes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.tenant_storage_bytes(uuid) TO lms_app;

-- ------------------------------------------------------------------ per learner and offering
CREATE FUNCTION lms.rollup_learners_apply(p_tenant uuid, p_offering uuid, p_participants uuid[], p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH off AS MATERIALIZED (
    SELECT o.id, o.status::text AS status, o.behind_after_days
      FROM lms.course_offerings o WHERE o.tenant_id = p_tenant AND o.id = p_offering),
  parts AS MATERIALIZED (
    SELECT p.id AS pid, tm.user_id, p.created_at AS enrolled_at
      FROM lms.course_participants p
      JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
     WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner'
       AND p.status = 'active' AND p.id = ANY (p_participants)),
  -- what a learner can see right now (the rule of the outline), required items only
  vis AS MATERIALIZED (
    SELECT i.id,
           greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at) AS eff_open
      FROM lms.content_items i
      JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
     WHERE i.tenant_id = p_tenant AND i.offering_id = p_offering AND i.required
       AND i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published
       AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= p_now
       AND (SELECT status FROM off) = 'published'),
  cutoff AS (SELECT p_now - make_interval(days => (SELECT behind_after_days FROM off)::int) AS at),
  totals AS (
    SELECT count(*)::int AS n, (count(*) FILTER (WHERE v.eff_open <= (SELECT at FROM cutoff)))::int AS n_due FROM vis v),
  prog AS MATERIALIZED (
    SELECT ip.participant_id AS pid,
           (count(*) FILTER (WHERE ip.status = 'completed' AND v.id IS NOT NULL))::int AS done,
           (count(*) FILTER (WHERE ip.status = 'completed' AND v.id IS NOT NULL
                              AND v.eff_open <= (SELECT at FROM cutoff)))::int AS done_due,
           max(ip.last_activity_at) AS last_at
      FROM lms.item_progress ip
      LEFT JOIN vis v ON v.id = ip.item_id
     WHERE ip.tenant_id = p_tenant AND ip.offering_id = p_offering AND ip.participant_id = ANY (p_participants)
     GROUP BY ip.participant_id),
  sub AS MATERIALIZED (
    SELECT s.participant_id AS pid, max(s.submitted_at) AS last_at
      FROM lms.submissions s
     WHERE s.tenant_id = p_tenant AND s.offering_id = p_offering AND s.participant_id = ANY (p_participants)
     GROUP BY s.participant_id),
  att AS MATERIALIZED (
    SELECT a.participant_id AS pid, max(greatest(a.started_at, a.submitted_at)) AS last_at
      FROM lms.attempts a
     WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering AND a.participant_id = ANY (p_participants)
     GROUP BY a.participant_id),
  watch AS MATERIALIZED (
    SELECT w.participant_id AS pid, sum(w.seconds)::int AS secs
      FROM lms.video_watch_days w
     WHERE w.tenant_id = p_tenant AND w.participant_id = ANY (p_participants)
     GROUP BY w.participant_id),
  -- deadlines: an assignment past its (extended) due date with nothing handed in; an assessment past its (extended) close with
  -- no attempt. Only items the learners can see (published, not archived) count.
  asg AS MATERIALIZED (
    SELECT a.item_id, a.due_at
      FROM lms.assignments a
      JOIN lms.content_items ci ON ci.tenant_id = a.tenant_id AND ci.id = a.item_id
      JOIN lms.content_modules m ON m.tenant_id = ci.tenant_id AND m.id = ci.module_id
     WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering AND a.due_at IS NOT NULL
       AND ci.deleted_at IS NULL AND m.deleted_at IS NULL AND ci.published AND m.published
       AND (SELECT status FROM off) = 'published'),
  miss_a AS MATERIALIZED (
    SELECT pa.pid, count(*)::int AS n
      FROM parts pa CROSS JOIN asg g
      LEFT JOIN lms.assignment_extensions e ON e.tenant_id = p_tenant AND e.assignment_item_id = g.item_id
                                           AND e.participant_id = pa.pid
     WHERE coalesce(e.extended_due_at, g.due_at) < p_now
       AND NOT EXISTS (SELECT 1 FROM lms.submissions s
                        WHERE s.tenant_id = p_tenant AND s.assignment_item_id = g.item_id AND s.participant_id = pa.pid)
     GROUP BY pa.pid),
  asm AS MATERIALIZED (
    SELECT s.item_id, s.closes_at
      FROM lms.assessments s
      JOIN lms.content_items ci ON ci.tenant_id = s.tenant_id AND ci.id = s.item_id
      JOIN lms.content_modules m ON m.tenant_id = ci.tenant_id AND m.id = ci.module_id
     WHERE s.tenant_id = p_tenant AND s.offering_id = p_offering AND s.closes_at IS NOT NULL
       AND ci.deleted_at IS NULL AND m.deleted_at IS NULL AND ci.published AND m.published
       AND (SELECT status FROM off) = 'published'),
  miss_s AS MATERIALIZED (
    SELECT pa.pid, count(*)::int AS n
      FROM parts pa CROSS JOIN asm g
      LEFT JOIN lms.assessment_accommodations ac ON ac.tenant_id = p_tenant AND ac.assessment_item_id = g.item_id
                                                AND ac.participant_id = pa.pid
     WHERE greatest(g.closes_at, coalesce(ac.extended_close_at, g.closes_at)) < p_now
       AND NOT EXISTS (SELECT 1 FROM lms.attempts t
                        WHERE t.tenant_id = p_tenant AND t.assessment_item_id = g.item_id AND t.participant_id = pa.pid)
     GROUP BY pa.pid),
  -- released scores as percent of the maximum, one per item (assignments and quizzes)
  sc AS MATERIALIZED (
    SELECT f.participant_id AS pid, round(f.score * 100 / f.max_score, 2) AS pct
      FROM lms.assignment_final_scores(p_tenant, p_offering) f
      JOIN lms.content_items ci ON ci.tenant_id = p_tenant AND ci.id = f.item_id AND ci.deleted_at IS NULL
     WHERE f.released AND f.max_score > 0 AND f.participant_id = ANY (p_participants)
    UNION ALL
    SELECT q.participant_id, round(q.score * 100 / q.max_score, 2)
      FROM lms.gradebook_assessment_scores(p_tenant, p_offering) q
      JOIN lms.content_items ci ON ci.tenant_id = p_tenant AND ci.id = q.item_id AND ci.deleted_at IS NULL
     WHERE q.released AND q.max_score > 0 AND q.participant_id = ANY (p_participants)),
  sc_agg AS MATERIALIZED (
    SELECT pid, round(avg(pct), 2) AS avg_pct, count(*)::int AS n FROM sc GROUP BY pid),
  up AS (
    INSERT INTO lms.rollup_learner_offering AS r (
        tenant_id, participant_id, offering_id, user_id, total_required, completed_required, behind_items,
        missed_deadlines, avg_score, scored_items, last_activity_at, enrolled_at, video_seconds, computed_at)
    SELECT p_tenant, pa.pid, p_offering, pa.user_id, t.n, coalesce(pr.done, 0),
           greatest(0, t.n_due - coalesce(pr.done_due, 0)),
           coalesce(ma.n, 0) + coalesce(ms.n, 0), sa.avg_pct, coalesce(sa.n, 0),
           greatest(pr.last_at, sb.last_at, at.last_at), pa.enrolled_at, coalesce(w.secs, 0), p_now
      FROM parts pa CROSS JOIN totals t
      LEFT JOIN prog pr ON pr.pid = pa.pid
      LEFT JOIN sub sb ON sb.pid = pa.pid
      LEFT JOIN att at ON at.pid = pa.pid
      LEFT JOIN watch w ON w.pid = pa.pid
      LEFT JOIN miss_a ma ON ma.pid = pa.pid
      LEFT JOIN miss_s ms ON ms.pid = pa.pid
      LEFT JOIN sc_agg sa ON sa.pid = pa.pid
    ON CONFLICT (tenant_id, participant_id) DO UPDATE SET
      offering_id = EXCLUDED.offering_id, user_id = EXCLUDED.user_id, total_required = EXCLUDED.total_required,
      completed_required = EXCLUDED.completed_required, behind_items = EXCLUDED.behind_items,
      missed_deadlines = EXCLUDED.missed_deadlines, avg_score = EXCLUDED.avg_score, scored_items = EXCLUDED.scored_items,
      last_activity_at = EXCLUDED.last_activity_at, enrolled_at = EXCLUDED.enrolled_at,
      video_seconds = EXCLUDED.video_seconds, computed_at = EXCLUDED.computed_at
    RETURNING 1)
  SELECT count(*) INTO n FROM up;

  -- learners who left (removed, suspended out) have no rollup row any more
  DELETE FROM lms.rollup_learner_offering r
   WHERE r.tenant_id = p_tenant AND r.participant_id = ANY (p_participants)
     AND NOT EXISTS (SELECT 1 FROM lms.course_participants p
                      WHERE p.tenant_id = p_tenant AND p.id = r.participant_id
                        AND p.participation = 'learner' AND p.status = 'active');
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_learners_apply(uuid, uuid, uuid[], timestamptz) FROM PUBLIC;

-- ------------------------------------------------------------------ per offering and local day (rebuilt for the offering)
CREATE FUNCTION lms.rollup_offering_day_apply(p_tenant uuid, p_offering uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  tz text := lms.tenant_tz(p_tenant);
  n integer;
BEGIN
  DELETE FROM lms.rollup_offering_day WHERE tenant_id = p_tenant AND offering_id = p_offering;
  WITH lp AS MATERIALIZED (
    SELECT p.id FROM lms.course_participants p
     WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner'),
  ev AS (
    SELECT ip.participant_id AS pid, lms.local_day(ip.completed_at, tz) AS d, 1 AS completed, 0 AS sub, 0 AS att, 0 AS vs
      FROM lms.item_progress ip
     WHERE ip.tenant_id = p_tenant AND ip.offering_id = p_offering AND ip.status = 'completed'
       AND ip.participant_id IN (SELECT id FROM lp)
    UNION ALL
    SELECT s.participant_id, lms.local_day(s.submitted_at, tz), 0, 1, 0, 0
      FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.offering_id = p_offering
       AND s.participant_id IN (SELECT id FROM lp)
    UNION ALL
    SELECT a.participant_id, lms.local_day(a.started_at, tz), 0, 0, 1, 0
      FROM lms.attempts a WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering
       AND a.participant_id IN (SELECT id FROM lp)
    UNION ALL
    SELECT w.participant_id, w.day, 0, 0, 0, w.seconds
      FROM lms.video_watch_days w WHERE w.tenant_id = p_tenant AND w.participant_id IN (SELECT id FROM lp)),
  ins AS (
    INSERT INTO lms.rollup_offering_day (tenant_id, offering_id, day, active_learners, items_completed, submissions,
                                         attempts, video_seconds)
    SELECT p_tenant, p_offering, d, count(DISTINCT pid), sum(completed), sum(sub), sum(att), sum(vs)
      FROM ev GROUP BY d
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_offering_day_apply(uuid, uuid) FROM PUBLIC;

-- ------------------------------------------------------------------ per group and day, per college and day (a day window)
CREATE FUNCTION lms.rollup_org_day_apply(p_tenant uuid, p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM lms.rollup_org_day WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to;
  WITH act AS MATERIALIZED (
    SELECT d.day, d.user_id, mp.department_id, mp.batch_id, mp.section_id, b.program_id
      FROM lms.member_activity_days d
      JOIN lms.tenant_memberships tm ON tm.tenant_id = d.tenant_id AND tm.user_id = d.user_id
      JOIN lms.member_profiles mp ON mp.tenant_id = tm.tenant_id AND mp.membership_id = tm.id
      LEFT JOIN lms.batches b ON b.tenant_id = mp.tenant_id AND b.id = mp.batch_id
     WHERE d.tenant_id = p_tenant AND d.day BETWEEN p_from AND p_to),
  ins AS (
    INSERT INTO lms.rollup_org_day (tenant_id, scope, scope_id, day, active_members)
    SELECT p_tenant, x.scope, x.scope_id, x.day, count(DISTINCT x.user_id)
      FROM (SELECT 'department' AS scope, department_id AS scope_id, day, user_id FROM act
            UNION ALL SELECT 'program', program_id, day, user_id FROM act
            UNION ALL SELECT 'batch', batch_id, day, user_id FROM act
            UNION ALL SELECT 'section', section_id, day, user_id FROM act) x
     WHERE x.scope_id IS NOT NULL
     GROUP BY x.scope, x.scope_id, x.day
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_org_day_apply(uuid, date, date) FROM PUBLIC;

CREATE FUNCTION lms.rollup_tenant_day_apply(p_tenant uuid, p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
  storage bigint := lms.tenant_storage_bytes(p_tenant);
BEGIN
  DELETE FROM lms.rollup_tenant_day WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to;
  WITH days AS (
    SELECT day FROM lms.member_activity_days WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to
    UNION SELECT day FROM lms.video_watch_days WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to),
  ins AS (
    INSERT INTO lms.rollup_tenant_day (tenant_id, day, active_users, active_learners, video_seconds, storage_bytes)
    SELECT p_tenant, dd.day,
           (SELECT count(*) FROM lms.member_activity_days a WHERE a.tenant_id = p_tenant AND a.day = dd.day),
           (SELECT count(*) FROM lms.member_activity_days a
             WHERE a.tenant_id = p_tenant AND a.day = dd.day
               AND EXISTS (SELECT 1 FROM lms.tenant_memberships tm
                             JOIN lms.course_participants p ON p.tenant_id = tm.tenant_id AND p.membership_id = tm.id
                            WHERE tm.tenant_id = p_tenant AND tm.user_id = a.user_id AND p.participation = 'learner')),
           (SELECT coalesce(sum(w.seconds), 0) FROM lms.video_watch_days w WHERE w.tenant_id = p_tenant AND w.day = dd.day),
           storage
      FROM days dd
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_tenant_day_apply(uuid, date, date) FROM PUBLIC;

-- ------------------------------------------------------------------ the refresh of ONE college (bounded; returns what is left)
-- 1. things that changed with the CLOCK (a due date passed, an item opened, an item became overdue) mark their offering;
-- 2. marked offerings expand to their learners; 3. a bounded batch of marked learners is recomputed and their offerings'
-- daily rows rebuilt; 4. the day windows of the college are rebuilt; 5. the state rows say "data as of".
-- First run (no state): every active learner is marked.
CREATE FUNCTION lms.rollup_run_tenant(p_tenant uuid, p_now timestamptz DEFAULT now(), p_max integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  wm timestamptz;
  tz text := lms.tenant_tz(p_tenant);
  claimed_p uuid[];
  claimed_at timestamptz[];
  off uuid;
  written integer := 0;
  left_n integer;
  oldest timestamptz;
  d_from date;
  d_to date := lms.local_day(p_now, tz);
BEGIN
  SELECT s.watermark INTO wm FROM lms.rollup_state s WHERE s.tenant_id = p_tenant AND s.kind = 'learner';
  IF wm IS NULL THEN
    INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id)
    SELECT p.tenant_id, p.id FROM lms.course_participants p
     WHERE p.tenant_id = p_tenant AND p.participation = 'learner' AND p.status = 'active'
    ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp();
    wm := '-infinity';
  ELSE
    -- time events since the last run
    INSERT INTO lms.rollup_dirty_offerings (tenant_id, offering_id)
    SELECT DISTINCT p_tenant, x.offering_id FROM (
      SELECT a.offering_id FROM lms.assignments a WHERE a.tenant_id = p_tenant AND a.due_at > wm AND a.due_at <= p_now
      UNION ALL SELECT a.offering_id FROM lms.assignment_extensions e
                  JOIN lms.assignments a ON a.tenant_id = e.tenant_id AND a.item_id = e.assignment_item_id
                 WHERE e.tenant_id = p_tenant AND e.extended_due_at > wm AND e.extended_due_at <= p_now
      UNION ALL SELECT s.offering_id FROM lms.assessments s WHERE s.tenant_id = p_tenant AND s.closes_at > wm AND s.closes_at <= p_now
      UNION ALL SELECT s.offering_id FROM lms.assessment_accommodations ac
                  JOIN lms.assessments s ON s.tenant_id = ac.tenant_id AND s.item_id = ac.assessment_item_id
                 WHERE ac.tenant_id = p_tenant AND ac.extended_close_at > wm AND ac.extended_close_at <= p_now
      UNION ALL SELECT i.offering_id
                  FROM lms.content_items i
                  JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
                  JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
                 WHERE i.tenant_id = p_tenant AND i.required AND i.deleted_at IS NULL
                   AND (greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at) > wm
                        AND greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at) <= p_now
                     OR greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at)
                          + make_interval(days => o.behind_after_days::int) > wm
                        AND greatest(coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz), i.created_at)
                          + make_interval(days => o.behind_after_days::int) <= p_now)
    ) x
    ON CONFLICT (tenant_id, offering_id) DO UPDATE SET marked_at = clock_timestamp();
  END IF;

  -- marked offerings -> marked learners (only the marks that existed when we looked; a newer mark stays)
  WITH gone AS (
    DELETE FROM lms.rollup_dirty_offerings d WHERE d.tenant_id = p_tenant AND d.marked_at <= clock_timestamp()
    RETURNING d.offering_id)
  INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id)
  SELECT p_tenant, p.id FROM lms.course_participants p
   WHERE p.tenant_id = p_tenant AND p.offering_id IN (SELECT offering_id FROM gone) AND p.participation = 'learner'
  ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp();

  -- a bounded batch of learners
  SELECT array_agg(c.participant_id), array_agg(c.marked_at) INTO claimed_p, claimed_at FROM (
    SELECT d.participant_id, d.marked_at FROM lms.rollup_dirty_participants d
     WHERE d.tenant_id = p_tenant ORDER BY d.marked_at, d.participant_id LIMIT p_max) c;
  IF claimed_p IS NOT NULL THEN
    FOR off IN
      SELECT DISTINCT p.offering_id FROM lms.course_participants p
       WHERE p.tenant_id = p_tenant AND p.id = ANY (claimed_p) AND p.participation = 'learner'
    LOOP
      written := written + lms.rollup_learners_apply(p_tenant, off, claimed_p, p_now);
      PERFORM lms.rollup_offering_day_apply(p_tenant, off);
    END LOOP;
    -- participants that are not learners any more / any longer have nothing to compute: just clear their marks
    DELETE FROM lms.rollup_dirty_participants d USING unnest(claimed_p, claimed_at) AS c (pid, at)
     WHERE d.tenant_id = p_tenant AND d.participant_id = c.pid AND d.marked_at = c.at;
  END IF;

  -- the day windows: from the day of the last run (minus one: a late row) to today
  d_from := CASE WHEN wm = '-infinity' THEN '1970-01-01'::date ELSE lms.local_day(wm, tz) - 1 END;
  PERFORM lms.rollup_org_day_apply(p_tenant, d_from, d_to);
  PERFORM lms.rollup_tenant_day_apply(p_tenant, d_from, d_to);

  SELECT count(*) + (SELECT count(*) FROM lms.rollup_dirty_offerings WHERE tenant_id = p_tenant),
         min(d.marked_at) INTO left_n, oldest
    FROM lms.rollup_dirty_participants d WHERE d.tenant_id = p_tenant;
  INSERT INTO lms.rollup_state (tenant_id, kind, watermark, as_of, rows_written)
  SELECT p_tenant, k, p_now,
         CASE WHEN k IN ('learner', 'offering_day') THEN least(p_now, coalesce(oldest, p_now)) ELSE p_now END,
         written
    FROM unnest(ARRAY['learner', 'offering_day', 'org_day', 'tenant_day']) k
  ON CONFLICT (tenant_id, kind) DO UPDATE SET
    watermark = EXCLUDED.watermark, as_of = EXCLUDED.as_of, rows_written = EXCLUDED.rows_written;
  RETURN left_n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_run_tenant(uuid, timestamptz, integer) FROM PUBLIC;

-- the colleges the worker refreshes (active ones), and the whole step for the worker's job
CREATE FUNCTION lms.rollup_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = lms, pg_temp
AS $$ SELECT t.id FROM lms.tenants t WHERE t.status = 'active' ORDER BY t.id $$;
REVOKE ALL ON FUNCTION lms.rollup_tenants() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION lms.rollup_run_tenant(uuid, timestamptz, integer) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.rollup_tenants() TO lms_app;

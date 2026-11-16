-- Step 12 performance fix, found by bench:analytics (10,000 students, 200 offerings) in a freshly loaded college WITHOUT statistics:
-- the planner believed every table had ~1 row and ran the per-day correlated counts of rollup_tenant_day_apply as nested loops over
-- 400,000 activity rows (statement timeout). Two changes, both the "planner rule" of steps 8 and 11:
--  1. the day statement is ONE aggregation (each source read once, the learners joined by a hash on a distinct set);
--  2. the rollup functions pin hash joins (enable_nestloop = off), kept because they were measured neutral or better in both
--     statistics states (docs/benchmarks.md, Step 12).
CREATE OR REPLACE FUNCTION lms.rollup_tenant_day_apply(p_tenant uuid, p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp SET enable_nestloop = off
AS $$
DECLARE
  n integer;
  storage bigint := lms.tenant_storage_bytes(p_tenant);
BEGIN
  DELETE FROM lms.rollup_tenant_day WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to;
  WITH learners AS MATERIALIZED (
    SELECT DISTINCT tm.user_id
      FROM lms.course_participants p
      JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
     WHERE p.tenant_id = p_tenant AND p.participation = 'learner'),
  act AS (
    SELECT a.day, count(*)::int AS users, (count(l.user_id))::int AS learners
      FROM lms.member_activity_days a
      LEFT JOIN learners l ON l.user_id = a.user_id
     WHERE a.tenant_id = p_tenant AND a.day BETWEEN p_from AND p_to
     GROUP BY a.day),
  vid AS (
    SELECT w.day, sum(w.seconds)::bigint AS secs
      FROM lms.video_watch_days w
     WHERE w.tenant_id = p_tenant AND w.day BETWEEN p_from AND p_to
     GROUP BY w.day),
  ins AS (
    INSERT INTO lms.rollup_tenant_day (tenant_id, day, active_users, active_learners, video_seconds, storage_bytes)
    SELECT p_tenant, d.day, coalesce(a.users, 0), coalesce(a.learners, 0), coalesce(v.secs, 0), storage
      FROM (SELECT day FROM act UNION SELECT day FROM vid) d
      LEFT JOIN act a ON a.day = d.day
      LEFT JOIN vid v ON v.day = d.day
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_tenant_day_apply(uuid, date, date) FROM PUBLIC;

ALTER FUNCTION lms.rollup_learners_apply(uuid, uuid, uuid[], timestamptz) SET enable_nestloop = off;
ALTER FUNCTION lms.rollup_offering_day_apply(uuid, uuid) SET enable_nestloop = off;
ALTER FUNCTION lms.rollup_org_day_apply(uuid, date, date) SET enable_nestloop = off;

-- Step 12 performance, third round. Once atrisk_flags was inlined (0049) the planner also pulled the settings subquery INTO the row
-- filter: `lms.atrisk_settings(...) ->> 'x'` was called for every one of 50,000 rows (530 ms, 3.4 s through the reports). OFFSET 0 makes
-- the settings a barrier that is evaluated ONCE, and the typed columns are cast once, so a row costs a few comparisons.
CREATE OR REPLACE FUNCTION lms.atrisk_flags(p_tenant uuid, p_now timestamptz)
RETURNS TABLE (participant_id uuid, offering_id uuid, user_id uuid, f_behind boolean, f_missed boolean, f_low boolean,
               f_inactive boolean)
LANGUAGE sql STABLE
AS $$
  SELECT r.participant_id, r.offering_id, r.user_id,
         coalesce(s.behind_on AND r.behind_items > 0, false),
         coalesce(s.missed_on AND r.missed_deadlines >= s.missed_n, false),
         coalesce(s.low_on AND r.avg_score IS NOT NULL AND r.avg_score < s.pass_mark, false),
         coalesce(s.inactive_on AND coalesce(r.last_activity_at, r.enrolled_at) < p_now - make_interval(days => s.inactive_days), false)
    FROM lms.rollup_learner_offering r
    JOIN lms.course_offerings o ON o.tenant_id = r.tenant_id AND o.id = r.offering_id AND o.status = 'published'
    CROSS JOIN (
      SELECT (x.v ->> 'behindEnabled')::boolean AS behind_on,
             (x.v ->> 'missedDeadlinesEnabled')::boolean AS missed_on, (x.v ->> 'missedDeadlines')::int AS missed_n,
             (x.v ->> 'lowScoreEnabled')::boolean AS low_on, (x.v ->> 'passMarkPercent')::numeric AS pass_mark,
             (x.v ->> 'inactiveEnabled')::boolean AS inactive_on, (x.v ->> 'inactiveDays')::int AS inactive_days
        FROM (SELECT lms.atrisk_settings(p_tenant) AS v OFFSET 0) x OFFSET 0) s
   WHERE r.tenant_id = p_tenant
$$;

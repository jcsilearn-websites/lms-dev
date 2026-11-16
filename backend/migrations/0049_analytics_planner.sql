-- Step 12 performance, second round (bench:analytics profile on 10,000 students x 200 offerings):
--  1. atrisk_flags had `SET search_path`, and a SQL function with a SET clause is NOT inlined: the planner computed all 50,000 learner
--     rows (1.6 s, 3.4 s under RLS) and only then applied the offering filter. Without the clause it is inlined, the filter reaches
--     the index on (tenant, offering) and the settings are read once. (It is not a definer function and every name in it is schema
--     qualified, so there is nothing for a search_path attack to hijack.)
--  2. JIT compilation cost 3-4x the run time of every rollup sub-call (the plans are cheap, but a college without statistics makes
--     them look expensive): the analytics functions run with jit = off.
CREATE OR REPLACE FUNCTION lms.atrisk_flags(p_tenant uuid, p_now timestamptz)
RETURNS TABLE (participant_id uuid, offering_id uuid, user_id uuid, f_behind boolean, f_missed boolean, f_low boolean,
               f_inactive boolean)
LANGUAGE sql STABLE
AS $$
  SELECT r.participant_id, r.offering_id, r.user_id,
         coalesce((s.v ->> 'behindEnabled')::boolean AND r.behind_items > 0, false),
         coalesce((s.v ->> 'missedDeadlinesEnabled')::boolean
                  AND r.missed_deadlines >= (s.v ->> 'missedDeadlines')::int, false),
         coalesce((s.v ->> 'lowScoreEnabled')::boolean AND r.avg_score IS NOT NULL
                  AND r.avg_score < (s.v ->> 'passMarkPercent')::numeric, false),
         coalesce((s.v ->> 'inactiveEnabled')::boolean
                  AND coalesce(r.last_activity_at, r.enrolled_at) < p_now - make_interval(days => (s.v ->> 'inactiveDays')::int),
                  false)
    FROM lms.rollup_learner_offering r
    JOIN lms.course_offerings o ON o.tenant_id = r.tenant_id AND o.id = r.offering_id AND o.status = 'published'
    CROSS JOIN (SELECT lms.atrisk_settings(p_tenant) AS v) s
   WHERE r.tenant_id = p_tenant
$$;

ALTER FUNCTION lms.rollup_learners_apply(uuid, uuid, uuid[], timestamptz) SET jit = off;
ALTER FUNCTION lms.rollup_offering_day_apply(uuid, uuid) SET jit = off;
ALTER FUNCTION lms.rollup_org_day_apply(uuid, date, date) SET jit = off;
ALTER FUNCTION lms.rollup_tenant_day_apply(uuid, date, date) SET jit = off;
ALTER FUNCTION lms.rollup_run_tenant(uuid, timestamptz, integer) SET jit = off;
ALTER FUNCTION lms.learner_dashboard(uuid, uuid, timestamptz) SET jit = off;
ALTER FUNCTION lms.usage_compute(uuid, date, timestamptz, jsonb) SET jit = off;
ALTER FUNCTION lms.usage_close_due(timestamptz, jsonb) SET jit = off;
ALTER FUNCTION lms.platform_usage(uuid, date, timestamptz, jsonb) SET jit = off;

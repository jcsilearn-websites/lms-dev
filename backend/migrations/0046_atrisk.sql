-- Step 12, part 4: the at-risk rules. TRANSPARENT rules over the learner rollup, no score and no model: a learner is flagged by
-- the rules that fired, and each rule's evidence is read from the source tables when somebody looks (analytics.repository).

-- The college's thresholds (tenant_settings key 'atRisk') over the defaults.
CREATE FUNCTION lms.atrisk_settings(p_tenant uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT '{"behindEnabled":true,"missedDeadlinesEnabled":true,"missedDeadlines":2,"lowScoreEnabled":true,
           "passMarkPercent":40,"inactiveEnabled":true,"inactiveDays":14}'::jsonb
         || coalesce((SELECT s.value FROM lms.tenant_settings s WHERE s.tenant_id = p_tenant AND s.key = 'atRisk'), '{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION lms.atrisk_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.atrisk_settings(uuid) TO lms_app;

-- One row per learner of a PUBLISHED offering with the four rule results. Behind uses the offering's own `behind_after_days`
-- (stored as behind_items by the rollup); the others use the college thresholds. Time-based rules (inactive) are judged at p_now.
CREATE FUNCTION lms.atrisk_flags(p_tenant uuid, p_now timestamptz)
RETURNS TABLE (participant_id uuid, offering_id uuid, user_id uuid, f_behind boolean, f_missed boolean, f_low boolean,
               f_inactive boolean)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
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
REVOKE ALL ON FUNCTION lms.atrisk_flags(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.atrisk_flags(uuid, timestamptz) TO lms_app;

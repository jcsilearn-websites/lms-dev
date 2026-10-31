-- Step 8: the rule every heartbeat starts with, as direct key lookups.
--
-- The benchmark (bench:progress) found that in a college whose rows were just loaded (no statistics yet) the planner
-- joined course_participants to tenant_memberships with the user filter applied AFTER the join: every heartbeat read
-- all participants of the offering and, for each, scanned the memberships (28 ms for 500 learners, growing with the
-- class and the college). The rule has exactly one answer per call, so it is written as a chain of lookups by unique
-- key (membership by (tenant, user), participant by (tenant, offering, membership), item and module by (tenant, id)):
-- each step is an index probe whatever the planner believes about table sizes (OFFSET 0 stops the planner from
-- flattening the subqueries back into a join it can misjudge). Same result, same columns, same grants.
CREATE OR REPLACE FUNCTION lms.learner_item_access(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid)
RETURNS TABLE (participant_id uuid, offering_id uuid, kind text, completion text, video_asset_id uuid,
               duration_ms integer, threshold smallint)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT p.id, i.offering_id, i.kind, i.completion, i.video_asset_id, va.duration_ms, o.completion_threshold
    FROM lms.content_items i
    CROSS JOIN LATERAL (SELECT m.available_from FROM lms.content_modules m
                         WHERE m.tenant_id = i.tenant_id AND m.id = i.module_id
                           AND m.deleted_at IS NULL AND m.published OFFSET 0) m
    CROSS JOIN LATERAL (SELECT oo.completion_threshold FROM lms.course_offerings oo
                         WHERE oo.tenant_id = i.tenant_id AND oo.id = i.offering_id
                           AND oo.status = 'published' OFFSET 0) o
    CROSS JOIN LATERAL (SELECT tm.id FROM lms.tenant_memberships tm
                         WHERE tm.tenant_id = p_tenant AND tm.user_id = p_user
                           AND tm.status = 'active' OFFSET 0) tm
    CROSS JOIN LATERAL (SELECT pp.id FROM lms.course_participants pp
                         WHERE pp.tenant_id = p_tenant AND pp.offering_id = i.offering_id
                           AND pp.membership_id = tm.id
                           AND pp.participation = 'learner' AND pp.status = 'active' OFFSET 0) p
    LEFT JOIN LATERAL (SELECT v.duration_ms FROM lms.video_assets v
                        WHERE v.tenant_id = i.tenant_id AND v.id = i.video_asset_id
                          AND v.status = 'ready' OFFSET 0) va ON true
   WHERE i.tenant_id = p_tenant AND i.id = p_item AND i.offering_id = p_offering
     AND i.deleted_at IS NULL AND i.published
     AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()
$$;

-- The reason a learner was refused (only on the failure path): the same lookups, membership first.
CREATE OR REPLACE FUNCTION lms.progress_gate(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid)
RETURNS TABLE (verdict text, participant_id uuid, offering_id uuid, kind text, completion text,
               video_asset_id uuid, duration_ms integer, threshold smallint)
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  parts text[];
BEGIN
  RETURN QUERY
    SELECT 'ok', g.participant_id, g.offering_id, g.kind, g.completion, g.video_asset_id, g.duration_ms, g.threshold
      FROM lms.learner_item_access(p_tenant, p_user, p_offering, p_item) g;
  IF FOUND THEN RETURN; END IF;
  SELECT array_agg(DISTINCT x.participation) INTO parts
    FROM lms.tenant_memberships tm
    CROSS JOIN LATERAL (
      SELECT p.participation::text AS participation
        FROM lms.course_participants p
       WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.membership_id = tm.id
         AND p.status = 'active'
         AND (p.participation <> 'learner'
              OR EXISTS (SELECT 1 FROM lms.course_offerings o
                          WHERE o.tenant_id = p_tenant AND o.id = p_offering AND o.status = 'published'))
       OFFSET 0) x
   WHERE tm.tenant_id = p_tenant AND tm.user_id = p_user AND tm.status = 'active';
  RETURN QUERY SELECT
    CASE WHEN parts IS NULL THEN 'no_offering'
         WHEN 'learner' = ANY (parts) THEN 'not_visible'
         ELSE 'forbidden' END,
    NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::integer, NULL::smallint;
END
$$;

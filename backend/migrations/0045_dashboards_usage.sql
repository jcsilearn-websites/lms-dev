-- Step 12, part 3: the learner dashboard (ONE definer call: the caller's own data only) and usage metering (monthly, per college).

-- ------------------------------------------------------------------ learner dashboard
-- Upcoming (14 days): hand-ins due, quizzes opening / closing, items becoming available, all across the learner's published
-- offerings; recently released grades (names only: no score leaves here); where to continue; the week's activity and the streak.
-- Everything is about p_user and nobody else; times are instants (the browser formats them in the college zone, sent along).
CREATE FUNCTION lms.learner_dashboard(p_tenant uuid, p_user uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  tz text := lms.tenant_tz(p_tenant);
  today date := lms.local_day(p_now, tz);
  horizon timestamptz := p_now + interval '14 days';
  result jsonb;
BEGIN
  WITH mine AS MATERIALIZED (
    SELECT p.id AS pid, p.offering_id AS oid, coalesce(o.title_override, c.title) AS title
      FROM lms.course_participants p
      JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
      JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
      JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
     WHERE p.tenant_id = p_tenant AND tm.user_id = p_user AND tm.status = 'active'
       AND p.participation = 'learner' AND p.status = 'active' AND o.status = 'published'),
  vis AS MATERIALIZED (
    SELECT i.id, i.offering_id AS oid, i.title, i.kind, i.available_from, m.available_from AS m_from, i.created_at
      FROM lms.content_items i
      JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
     WHERE i.tenant_id = p_tenant AND i.offering_id IN (SELECT oid FROM mine)
       AND i.deleted_at IS NULL AND m.deleted_at IS NULL AND i.published AND m.published),
  up AS (
    SELECT 'assignment_due' AS kind, mine.oid, mine.title AS offering_title, a.item_id, v.title,
           coalesce(e.extended_due_at, a.due_at) AS at
      FROM mine
      JOIN lms.assignments a ON a.tenant_id = p_tenant AND a.offering_id = mine.oid
      JOIN vis v ON v.id = a.item_id
      LEFT JOIN lms.assignment_extensions e ON e.tenant_id = p_tenant AND e.assignment_item_id = a.item_id
                                           AND e.participant_id = mine.pid
     WHERE coalesce(e.extended_due_at, a.due_at) > p_now AND coalesce(e.extended_due_at, a.due_at) <= horizon
       AND NOT EXISTS (SELECT 1 FROM lms.submissions s
                        WHERE s.tenant_id = p_tenant AND s.assignment_item_id = a.item_id AND s.participant_id = mine.pid)
    UNION ALL
    SELECT 'assessment_closes', mine.oid, mine.title, s.item_id, v.title,
           greatest(s.closes_at, coalesce(ac.extended_close_at, s.closes_at))
      FROM mine
      JOIN lms.assessments s ON s.tenant_id = p_tenant AND s.offering_id = mine.oid
      JOIN vis v ON v.id = s.item_id
      LEFT JOIN lms.assessment_accommodations ac ON ac.tenant_id = p_tenant AND ac.assessment_item_id = s.item_id
                                                AND ac.participant_id = mine.pid
     WHERE greatest(s.closes_at, coalesce(ac.extended_close_at, s.closes_at)) > p_now
       AND greatest(s.closes_at, coalesce(ac.extended_close_at, s.closes_at)) <= horizon
       AND NOT EXISTS (SELECT 1 FROM lms.attempts t
                        WHERE t.tenant_id = p_tenant AND t.assessment_item_id = s.item_id AND t.participant_id = mine.pid
                          AND t.status <> 'in_progress')
    UNION ALL
    SELECT 'assessment_opens', mine.oid, mine.title, s.item_id, v.title, s.opens_at
      FROM mine
      JOIN lms.assessments s ON s.tenant_id = p_tenant AND s.offering_id = mine.oid
      JOIN vis v ON v.id = s.item_id
     WHERE s.opens_at > p_now AND s.opens_at <= horizon
    UNION ALL
    SELECT 'item_available', mine.oid, mine.title, v.id, v.title,
           greatest(coalesce(greatest(v.available_from, v.m_from), '-infinity'::timestamptz), v.created_at)
      FROM mine JOIN vis v ON v.oid = mine.oid
     WHERE v.kind NOT IN ('assessment', 'assignment')
       AND greatest(coalesce(greatest(v.available_from, v.m_from), '-infinity'::timestamptz), v.created_at) > p_now
       AND greatest(coalesce(greatest(v.available_from, v.m_from), '-infinity'::timestamptz), v.created_at) <= horizon),
  up_page AS (SELECT * FROM up ORDER BY at, item_id LIMIT 30),
  rel AS (
    SELECT 'assignment' AS kind, mine.oid, mine.title AS offering_title, gr.assignment_item_id AS item_id, v.title,
           gr.released_at AS at
      FROM mine
      JOIN lms.assignment_grades gr ON gr.tenant_id = p_tenant AND gr.participant_id = mine.pid
      JOIN vis v ON v.id = gr.assignment_item_id
     WHERE gr.released_at IS NOT NULL
    UNION ALL
    SELECT 'assessment', mine.oid, mine.title, t.assessment_item_id, v.title, t.released_at
      FROM mine
      JOIN lms.attempts t ON t.tenant_id = p_tenant AND t.participant_id = mine.pid
      JOIN vis v ON v.id = t.assessment_item_id
     WHERE t.released_at IS NOT NULL),
  rel_page AS (SELECT * FROM rel ORDER BY at DESC LIMIT 5),
  resume AS (
    SELECT ip.offering_id AS oid, mine.title AS offering_title, ip.item_id, v.title, ip.last_activity_at
      FROM mine
      JOIN lms.item_progress ip ON ip.tenant_id = p_tenant AND ip.participant_id = mine.pid
      JOIN vis v ON v.id = ip.item_id
     WHERE ip.status = 'in_progress'
     ORDER BY ip.last_activity_at DESC LIMIT 1),
  act AS (
    SELECT d.day FROM lms.member_activity_days d
     WHERE d.tenant_id = p_tenant AND d.user_id = p_user AND d.day > today - 400 AND d.day <= today),
  island AS (
    SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp FROM act),
  streak AS (
    SELECT coalesce((SELECT count(*) FROM island
                      WHERE grp = (SELECT grp FROM island ORDER BY day DESC LIMIT 1)
                        AND (SELECT max(day) FROM act) >= today - 1), 0)::int AS n),
  wk AS (
    SELECT g::date AS day, EXISTS (SELECT 1 FROM act WHERE act.day = g::date) AS active
      FROM generate_series((today - (extract(isodow FROM today)::int - 1))::timestamp,
                           (today - (extract(isodow FROM today)::int - 1) + 6)::timestamp, interval '1 day') g)
  SELECT jsonb_build_object(
    'timeZone', tz, 'today', today,
    'upcoming', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'offeringId', oid, 'offeringTitle', offering_title,
                     'itemId', item_id, 'title', title, 'at', at) ORDER BY at, item_id) FROM up_page), '[]'::jsonb),
    'released', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'offeringId', oid, 'offeringTitle', offering_title,
                     'itemId', item_id, 'title', title, 'at', at) ORDER BY at DESC) FROM rel_page), '[]'::jsonb),
    'resume', (SELECT jsonb_build_object('offeringId', oid, 'offeringTitle', offering_title, 'itemId', item_id, 'title', title)
                 FROM resume),
    'week', coalesce((SELECT jsonb_agg(jsonb_build_object('date', day, 'active', active) ORDER BY day) FROM wk), '[]'::jsonb),
    'streak', (SELECT n FROM streak))
  INTO result;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION lms.learner_dashboard(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.learner_dashboard(uuid, uuid, timestamptz) TO lms_app;

-- ------------------------------------------------------------------ usage metering
-- p_mix: the assumed share of viewing per rendition, e.g. {"360p":0.2,"480p":0.3,"720p":0.5}. Renditions a video does not have
-- (it is never upscaled) drop out and the rest is re-weighted. Bytes per second of a rendition = its measured bytes / duration.
CREATE FUNCTION lms.usage_compute(p_tenant uuid, p_month date, p_now timestamptz, p_mix jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  m_end date := (p_month + interval '1 month')::date;
  def jsonb := coalesce((SELECT s.value FROM lms.tenant_settings s WHERE s.tenant_id = p_tenant AND s.key = 'usage'), '{}'::jsonb);
  min_days integer := greatest(1, coalesce((def ->> 'minActiveDays')::int, 1));
  learners_only boolean := coalesce((def ->> 'learnersOnly')::boolean, true);
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'timeZone', lms.tenant_tz(p_tenant),
    'activeUsers', (SELECT count(DISTINCT d.user_id) FROM lms.member_activity_days d
                     WHERE d.tenant_id = p_tenant AND d.day >= p_month AND d.day < m_end),
    'billableLearners', (
      SELECT count(*) FROM (
        SELECT d.user_id FROM lms.member_activity_days d
         WHERE d.tenant_id = p_tenant AND d.day >= p_month AND d.day < m_end
         GROUP BY d.user_id HAVING count(*) >= min_days) u
       WHERE NOT learners_only OR EXISTS (
         SELECT 1 FROM lms.tenant_memberships tm
           JOIN lms.course_participants p ON p.tenant_id = tm.tenant_id AND p.membership_id = tm.id
          WHERE tm.tenant_id = p_tenant AND tm.user_id = u.user_id AND p.participation = 'learner'
            AND p.created_at < (m_end::timestamp AT TIME ZONE lms.tenant_tz(p_tenant)))),
    'videoSeconds', (SELECT coalesce(sum(w.seconds), 0) FROM lms.video_watch_days w
                      WHERE w.tenant_id = p_tenant AND w.day >= p_month AND w.day < m_end),
    'videoGbEstimate', (
      SELECT round(coalesce(sum(w.seconds * bps.v), 0) / 1000000000.0, 3)
        FROM lms.video_watch_days w
        JOIN lms.video_assets va ON va.tenant_id = w.tenant_id AND va.id = w.asset_id AND va.duration_ms > 0
        CROSS JOIN LATERAL (
          SELECT coalesce(sum(mx.weight * (r ->> 'bytes')::numeric / (va.duration_ms / 1000.0))
                          / nullif(sum(mx.weight), 0), 0) AS v
            FROM jsonb_array_elements(va.renditions) r
            CROSS JOIN LATERAL (SELECT coalesce((p_mix ->> (r ->> 'name'))::numeric, 0) AS weight) mx) bps
       WHERE w.tenant_id = p_tenant AND w.day >= p_month AND w.day < m_end),
    'storageBytes', lms.tenant_storage_bytes(p_tenant),
    'offerings', (SELECT count(*) FROM lms.course_offerings o
                   WHERE o.tenant_id = p_tenant AND o.status <> 'draft'
                     AND o.created_at < (m_end::timestamp AT TIME ZONE lms.tenant_tz(p_tenant))),
    'activeOfferings', (SELECT count(DISTINCT r.offering_id) FROM lms.rollup_offering_day r
                         WHERE r.tenant_id = p_tenant AND r.day >= p_month AND r.day < m_end AND r.active_learners > 0),
    'definition', jsonb_build_object('minActiveDays', min_days, 'learnersOnly', learners_only))
  INTO result;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION lms.usage_compute(uuid, date, timestamptz, jsonb) FROM PUBLIC;

-- Closes every college's month that ended (in the college's own zone) at least two hours ago and has no snapshot, looking back at
-- most three months. Immutable once written: ON CONFLICT DO NOTHING, and a trigger refuses UPDATE / DELETE.
CREATE FUNCTION lms.usage_close_due(p_now timestamptz, p_mix jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  t record;
  last_month date;
  mth date;
  closed integer := 0;
  usage jsonb;
  ins integer;
BEGIN
  FOR t IN SELECT x.id, x.created_at FROM lms.tenants x WHERE x.status = 'active' ORDER BY x.id LOOP
    last_month := (date_trunc('month', (p_now - interval '2 hours') AT TIME ZONE lms.tenant_tz(t.id))::date - interval '1 month')::date;
    mth := greatest(last_month - interval '3 months', date_trunc('month', t.created_at AT TIME ZONE lms.tenant_tz(t.id))::date)::date;
    WHILE mth <= last_month LOOP
      IF NOT EXISTS (SELECT 1 FROM lms.usage_snapshots s WHERE s.tenant_id = t.id AND s.month = mth) THEN
        -- bring the rollups level first (the active-offering count reads them)
        WHILE lms.rollup_run_tenant(t.id, p_now, 5000) > 0 LOOP NULL; END LOOP;
        usage := lms.usage_compute(t.id, mth, p_now, p_mix);
        INSERT INTO lms.usage_snapshots (tenant_id, month, revision, time_zone, billable_learners, active_users, video_seconds,
                                         video_gb_estimate, storage_bytes, offerings, active_offerings, definition,
                                         rendition_mix, closed_at)
        VALUES (t.id, mth, 1, usage ->> 'timeZone', (usage ->> 'billableLearners')::int, (usage ->> 'activeUsers')::int,
                (usage ->> 'videoSeconds')::bigint, (usage ->> 'videoGbEstimate')::numeric,
                (usage ->> 'storageBytes')::bigint, (usage ->> 'offerings')::int, (usage ->> 'activeOfferings')::int,
                usage -> 'definition', p_mix, p_now)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS ins = ROW_COUNT;
        closed := closed + ins;
      END IF;
      mth := (mth + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN closed;
END
$$;
REVOKE ALL ON FUNCTION lms.usage_close_due(timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.usage_close_due(timestamptz, jsonb) TO lms_app;

-- The platform's view: every college for one month. A closed month is its newest snapshot revision; the open month is computed
-- now and marked provisional. AGGREGATES ONLY (no person, no course).
CREATE FUNCTION lms.platform_usage(p_actor uuid, p_month date, p_now timestamptz, p_mix jsonb)
RETURNS TABLE (tenant_id uuid, slug text, name text, status text, provisional boolean, revision integer, time_zone text,
               billable_learners integer, active_users integer, video_seconds bigint, video_gb_estimate numeric,
               storage_bytes bigint, offerings integer, active_offerings integer, members integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  t record;
  s record;
  usage jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  IF date_trunc('month', p_month) <> p_month THEN
    RAISE EXCEPTION 'month must be the first day of a month' USING ERRCODE = '22023';
  END IF;
  FOR t IN SELECT x.id, x.slug, x.name, x.status::text AS status FROM lms.tenants x ORDER BY x.slug LOOP
    SELECT * INTO s FROM lms.usage_snapshots u WHERE u.tenant_id = t.id AND u.month = p_month ORDER BY u.revision DESC LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT t.id, t.slug, t.name, t.status, false, s.revision::int, s.time_zone, s.billable_learners, s.active_users,
        s.video_seconds, s.video_gb_estimate, s.storage_bytes, s.offerings, s.active_offerings,
        (SELECT count(*)::int FROM lms.tenant_memberships m WHERE m.tenant_id = t.id AND m.status = 'active');
    ELSE
      usage := lms.usage_compute(t.id, p_month, p_now, p_mix);
      RETURN QUERY SELECT t.id, t.slug, t.name, t.status, true, 0, usage ->> 'timeZone', (usage ->> 'billableLearners')::int,
        (usage ->> 'activeUsers')::int, (usage ->> 'videoSeconds')::bigint, (usage ->> 'videoGbEstimate')::numeric,
        (usage ->> 'storageBytes')::bigint, (usage ->> 'offerings')::int, (usage ->> 'activeOfferings')::int,
        (SELECT count(*)::int FROM lms.tenant_memberships m WHERE m.tenant_id = t.id AND m.status = 'active');
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION lms.platform_usage(uuid, date, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_usage(uuid, date, timestamptz, jsonb) TO lms_app;

-- Step 12 fix: "data as of" must not overstate freshness. A marked OFFERING expands to marks on its learners stamped with the time of
-- the expansion (that is what keeps the delete-by-equality of the refresh safe), which hid how old the change really was. The
-- expansion now remembers the oldest offering mark it consumed, and while any mark is left, as_of is the older of that and the
-- oldest remaining learner mark. Same function otherwise (migration 0044).
CREATE OR REPLACE FUNCTION lms.rollup_run_tenant(p_tenant uuid, p_now timestamptz DEFAULT now(), p_max integer DEFAULT 500)
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
  exp_oldest timestamptz;
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

  WITH gone AS (
    DELETE FROM lms.rollup_dirty_offerings d WHERE d.tenant_id = p_tenant AND d.marked_at <= clock_timestamp()
    RETURNING d.offering_id, d.marked_at),
  ins AS (
    INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id)
    SELECT p_tenant, p.id FROM lms.course_participants p
     WHERE p.tenant_id = p_tenant AND p.offering_id IN (SELECT offering_id FROM gone) AND p.participation = 'learner'
    ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp()
    RETURNING 1)
  SELECT (SELECT min(marked_at) FROM gone) INTO exp_oldest;

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
    DELETE FROM lms.rollup_dirty_participants d USING unnest(claimed_p, claimed_at) AS c (pid, at)
     WHERE d.tenant_id = p_tenant AND d.participant_id = c.pid AND d.marked_at = c.at;
  END IF;

  d_from := CASE WHEN wm = '-infinity' THEN '1970-01-01'::date ELSE lms.local_day(wm, tz) - 1 END;
  PERFORM lms.rollup_org_day_apply(p_tenant, d_from, d_to);
  PERFORM lms.rollup_tenant_day_apply(p_tenant, d_from, d_to);

  SELECT count(*) + (SELECT count(*) FROM lms.rollup_dirty_offerings WHERE tenant_id = p_tenant),
         min(d.marked_at) INTO left_n, oldest
    FROM lms.rollup_dirty_participants d WHERE d.tenant_id = p_tenant;
  INSERT INTO lms.rollup_state (tenant_id, kind, watermark, as_of, rows_written)
  SELECT p_tenant, k, p_now,
         CASE WHEN k IN ('learner', 'offering_day') AND left_n > 0
              THEN least(p_now, coalesce(oldest, p_now), coalesce(exp_oldest, p_now))
              ELSE p_now END,
         written
    FROM unnest(ARRAY['learner', 'offering_day', 'org_day', 'tenant_day']) k
  ON CONFLICT (tenant_id, kind) DO UPDATE SET
    watermark = EXCLUDED.watermark, as_of = EXCLUDED.as_of, rows_written = EXCLUDED.rows_written;
  RETURN left_n;
END
$$;

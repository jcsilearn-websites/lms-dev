-- assessment_start: a concurrent start of the SAME learner must resume the attempt that just began, never answer "no attempts left".
--
-- Found by the flakiness job (the third full run of the first manual dispatch): test/assessments.test.ts "concurrent starts make one" got 409
-- no_attempts_left. The function reads in three steps, each with its own snapshot (READ COMMITTED, plpgsql):
--   1. is there an in-progress attempt?   -> none
--   2. (another tab / device / a double click commits its new attempt here)
--   3. how many attempts were used?       -> 1, and the assessment allows 1  ->  'no_attempts_left'
-- The second caller never reached the "another tab started it a moment ago" branch, so a learner who opened the exam twice at the
-- same moment was told they had no attempts left although their attempt was running. Reproduced deterministically by widening the
-- window between 1 and 3 with pg_sleep (the second start returned no_attempts_left); it needs a few microseconds locally, so a fast
-- machine hides it and a loaded CI runner shows it.
--
-- The fix: when the count says "no attempts left", look for an in-progress attempt AGAIN (a fresh snapshot): if there is one it is
-- THE attempt (resumed), exactly as the INSERT ... ON CONFLICT branch already answers for the call that loses at the insert. Only
-- that branch changes; everything else is the function of migration 0029, restated because CREATE OR REPLACE needs the whole body.
CREATE OR REPLACE FUNCTION lms.assessment_start(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  s lms.assessments;
  acc lms.assessment_accommodations;
  att lms.attempts;
  close_eff timestamptz;
  used integer;
  new_id uuid := lms.uuid_v7();
  inserted uuid;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assessment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  SELECT * INTO s FROM lms.assessments WHERE tenant_id = p_tenant AND item_id = p_item;

  SELECT * INTO att FROM lms.attempts
   WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id AND status = 'in_progress';
  IF FOUND THEN
    IF now() > att.deadline_at + make_interval(secs => p_grace) THEN
      PERFORM lms.attempts_finalize(ARRAY[p_tenant], ARRAY[att.id], 'deadline');
    ELSE
      RETURN jsonb_build_object('result', 'ok', 'attemptId', att.id, 'resumed', true);
    END IF;
  END IF;

  SELECT * INTO acc FROM lms.assessment_accommodations
   WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id;
  close_eff := CASE WHEN s.closes_at IS NULL THEN NULL ELSE greatest(s.closes_at, coalesce(acc.extended_close_at, s.closes_at)) END;
  IF s.opens_at IS NOT NULL AND now() < s.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  IF close_eff IS NOT NULL AND now() >= close_eff THEN RETURN jsonb_build_object('result', 'closed'); END IF;
  SELECT count(*) INTO used FROM lms.attempts
   WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id;
  IF used >= s.attempts_allowed THEN
    -- a concurrent start of THIS learner may have committed since the check above: its attempt is THE attempt
    SELECT * INTO att FROM lms.attempts
     WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id AND status = 'in_progress';
    IF FOUND AND now() <= att.deadline_at + make_interval(secs => p_grace) THEN
      RETURN jsonb_build_object('result', 'ok', 'attemptId', att.id, 'resumed', true);
    END IF;
    RETURN jsonb_build_object('result', 'no_attempts_left');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.assessment_slots WHERE tenant_id = p_tenant AND assessment_item_id = p_item) THEN
    RETURN jsonb_build_object('result', 'empty');
  END IF;

  BEGIN
    INSERT INTO lms.attempts (id, tenant_id, assessment_item_id, offering_id, participant_id, attempt_no, deadline_at)
    VALUES (new_id, p_tenant, p_item, p_offering, g.participant_id, used + 1,
            least(now() + make_interval(mins => coalesce(s.time_limit_minutes, 1440) + coalesce(acc.extra_minutes, 0)),
                  coalesce(close_eff, 'infinity'::timestamptz)))
    ON CONFLICT DO NOTHING
    RETURNING id INTO inserted;
    IF inserted IS NULL THEN
      -- another tab started it a moment ago: that attempt is THE attempt
      SELECT id INTO inserted FROM lms.attempts
       WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id AND status = 'in_progress';
      RETURN jsonb_build_object('result', 'ok', 'attemptId', inserted, 'resumed', true);
    END IF;
    INSERT INTO lms.attempt_questions (tenant_id, attempt_id, position, assessment_item_id, question_id,
                                       question_version_id, scored_version_id, points, option_order)
    SELECT p_tenant, new_id, d.pos, p_item, d.question_id, d.version_id, d.version_id, d.points, d.option_order
      FROM lms.assessment_draw(p_tenant, p_item) d;
  EXCEPTION WHEN SQLSTATE 'LMS01' THEN
    RETURN jsonb_build_object('result', 'pool_too_small');
  END;
  -- opening the assessment is progress (and, with it, the item is archived rather than deleted from now on)
  INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id)
  VALUES (p_tenant, g.participant_id, p_item, g.offering_id)
  ON CONFLICT (tenant_id, participant_id, item_id) DO NOTHING;
  RETURN jsonb_build_object('result', 'ok', 'attemptId', new_id, 'resumed', false);
END
$$;
REVOKE ALL ON FUNCTION lms.assessment_start(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_start(uuid, uuid, uuid, uuid, integer) TO lms_app;

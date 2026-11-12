-- Step 10b: DEADLINE FAIRNESS UNDER LOAD.
--
-- A request that ARRIVED before a deadline must not be marked late because it waited for a database connection. Node takes the
-- arrival time of the request before anything waits (core/deadline.ts) and the deadline-sensitive definer functions use it
-- instead of now(): assignment finalize (and the upload request, whose time is the "upload began" of the grace rule), exam
-- autosave and exam submit.
--
-- lms.effective_arrival(arrival, max_age) is the ONE place that validates the claim: never in the future (clamped to now(), so
-- a fast clock buys nothing), never older than `max_age` seconds (clamped, so a slow clock or a replayed value buys at most that
-- much). A plain request is bounded by a short queue wait; a request that carries a valid signed receipt (HMAC, checked in
-- Node) by the receipt window. The new parameters are trailing and defaulted: a caller that passes none gets now(), the old rule.

CREATE FUNCTION lms.effective_arrival(p_arrival timestamptz, p_max_age integer)
RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT greatest(least(coalesce(p_arrival, now()), now()), now() - make_interval(secs => greatest(coalesce(p_max_age, 0), 0)))
$$;
REVOKE ALL ON FUNCTION lms.effective_arrival(timestamptz, integer) FROM PUBLIC;

-- ------------------------------------------------------------------ assignments
DROP FUNCTION lms.assignment_upload_begin(uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, integer);
CREATE FUNCTION lms.assignment_upload_begin(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid,
                                            p_storage_key text, p_name text, p_content_type text, p_size bigint,
                                            p_grace integer, p_arrival timestamptz DEFAULT NULL,
                                            p_max_age integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  t record;
  drafts integer;
  arr timestamptz := lms.effective_arrival(p_arrival, p_max_age);
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assignment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  IF NOT a.allow_file THEN RETURN jsonb_build_object('result', 'files_not_allowed'); END IF;
  IF p_size > a.max_file_mb::bigint * 1048576 THEN
    RETURN jsonb_build_object('result', 'file_too_large', 'maxMb', a.max_file_mb);
  END IF;
  IF a.opens_at IS NOT NULL AND arr < a.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  SELECT * INTO t FROM lms.assignment_timing(p_tenant, p_item, g.participant_id);
  IF t.due IS NOT NULL AND arr > t.cutoff THEN RETURN jsonb_build_object('result', 'closed'); END IF;
  IF NOT a.resubmission_allowed AND EXISTS (
       SELECT 1 FROM lms.submissions s
        WHERE s.tenant_id = p_tenant AND s.assignment_item_id = p_item AND s.participant_id = g.participant_id) THEN
    RETURN jsonb_build_object('result', 'already_submitted');
  END IF;
  SELECT count(*) INTO drafts FROM lms.assignment_uploads u
   WHERE u.tenant_id = p_tenant AND u.assignment_item_id = p_item AND u.participant_id = g.participant_id;
  -- a few spare slots so replacing a file does not need a clean-up first; the abuse stays bounded
  IF drafts >= a.max_files + 5 THEN RETURN jsonb_build_object('result', 'too_many_files'); END IF;

  INSERT INTO lms.files (id, tenant_id, storage_key, original_name, content_type, declared_size, created_by)
  VALUES (p_file, p_tenant, p_storage_key, p_name, p_content_type, p_size, p_user);
  INSERT INTO lms.assignment_uploads (tenant_id, file_id, assignment_item_id, participant_id, created_at)
  VALUES (p_tenant, p_file, p_item, g.participant_id, arr);
  RETURN jsonb_build_object('result', 'ok', 'maxMb', a.max_file_mb, 'maxFiles', a.max_files);
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_upload_begin(uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, integer, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_upload_begin(uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, integer, timestamptz, integer) TO lms_app;

DROP FUNCTION lms.assignment_submit(uuid, uuid, uuid, uuid, uuid, text, text, uuid[], boolean, integer);
CREATE FUNCTION lms.assignment_submit(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_request_key uuid,
                                      p_text text, p_link text, p_files uuid[], p_confirm_late boolean,
                                      p_grace integer, p_arrival timestamptz DEFAULT NULL,
                                      p_max_age integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  t record;
  prev lms.submissions;
  existing lms.submissions;
  file_ids uuid[] := coalesce(p_files, '{}');
  usable integer;
  first_upload timestamptz;
  late integer := 0;
  grace boolean := false;
  pct numeric;
  new_id uuid := lms.uuid_v7();
  nver smallint;
  arr timestamptz := lms.effective_arrival(p_arrival, p_max_age);
  body text := nullif(btrim(coalesce(p_text, '')), '');
  link text := nullif(btrim(coalesce(p_link, '')), '');
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assignment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  -- one finalize at a time per learner and assignment (two tabs, a double click)
  PERFORM pg_advisory_xact_lock(hashtextextended(p_item::text || g.participant_id::text, 10));

  -- the same request again: that version IS the answer
  SELECT * INTO existing FROM lms.submissions
   WHERE tenant_id = p_tenant AND assignment_item_id = p_item AND participant_id = g.participant_id
     AND request_key = p_request_key;
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'ok', 'submissionId', existing.id, 'versionNo', existing.version_no,
                              'lateSeconds', existing.late_seconds, 'repeated', true);
  END IF;

  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  IF a.opens_at IS NOT NULL AND arr < a.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  IF body IS NOT NULL AND NOT a.allow_text THEN RETURN jsonb_build_object('result', 'text_not_allowed'); END IF;
  IF link IS NOT NULL AND NOT a.allow_link THEN RETURN jsonb_build_object('result', 'link_not_allowed'); END IF;
  IF cardinality(file_ids) > 0 AND NOT a.allow_file THEN RETURN jsonb_build_object('result', 'files_not_allowed'); END IF;
  IF body IS NULL AND link IS NULL AND cardinality(file_ids) = 0 THEN RETURN jsonb_build_object('result', 'empty'); END IF;
  IF length(body) > 50000 THEN RETURN jsonb_build_object('result', 'text_too_long'); END IF;
  IF link IS NOT NULL AND (length(link) > 2000 OR link !~ '^https?://') THEN
    RETURN jsonb_build_object('result', 'invalid_link');
  END IF;
  IF cardinality(file_ids) > a.max_files THEN
    RETURN jsonb_build_object('result', 'too_many_files', 'maxFiles', a.max_files);
  END IF;
  IF cardinality(file_ids) <> (SELECT count(DISTINCT x) FROM unnest(file_ids) x) THEN
    RETURN jsonb_build_object('result', 'files_not_ready');
  END IF;

  -- every file must be this learner's READY draft upload for this assignment
  SELECT count(*), min(u.created_at) INTO usable, first_upload
    FROM lms.assignment_uploads u
    JOIN lms.files f ON f.tenant_id = u.tenant_id AND f.id = u.file_id AND f.status = 'ready'
   WHERE u.tenant_id = p_tenant AND u.assignment_item_id = p_item AND u.participant_id = g.participant_id
     AND u.file_id = ANY (file_ids);
  IF usable <> cardinality(file_ids) THEN RETURN jsonb_build_object('result', 'files_not_ready'); END IF;

  SELECT * INTO prev FROM lms.submissions
   WHERE tenant_id = p_tenant AND assignment_item_id = p_item AND participant_id = g.participant_id
   ORDER BY version_no DESC LIMIT 1;
  IF FOUND AND NOT a.resubmission_allowed THEN RETURN jsonb_build_object('result', 'already_submitted'); END IF;

  -- deadline fairness: the server's clock now; an upload that began in time and is finalized within the grace period
  -- counts on time
  SELECT * INTO t FROM lms.assignment_timing(p_tenant, p_item, g.participant_id);
  IF t.due IS NOT NULL AND arr > t.due THEN
    IF first_upload IS NOT NULL AND first_upload <= t.due AND arr <= t.due + make_interval(secs => p_grace) THEN
      grace := true;
    ELSIF a.late_policy = 'allowed' AND arr <= t.cutoff THEN
      late := ceil(extract(epoch FROM arr - t.due))::integer;
    ELSE
      RETURN jsonb_build_object('result', 'closed');
    END IF;
  END IF;

  IF late > 0 THEN
    pct := lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, late);
    IF prev.id IS NOT NULL AND prev.late_seconds = 0 AND NOT coalesce(p_confirm_late, false) THEN
      RETURN jsonb_build_object('result', 'confirm_late', 'lateSeconds', late, 'penaltyPercent', pct,
                                'penaltyPoints', round(a.max_points * pct / 100, 2), 'maxPoints', a.max_points,
                                'currentVersionNo', prev.version_no);
    END IF;
  END IF;

  nver := coalesce(prev.version_no, 0) + 1;
  INSERT INTO lms.submissions (id, tenant_id, assignment_item_id, offering_id, participant_id, version_no, text_body,
                               link_url, request_key, late_seconds, on_grace, submitted_at)
  VALUES (new_id, p_tenant, p_item, p_offering, g.participant_id, nver, body, link, p_request_key, late, grace, arr);
  INSERT INTO lms.submission_files (tenant_id, submission_id, file_id, position)
  SELECT p_tenant, new_id, f.file_id, f.ord FROM unnest(file_ids) WITH ORDINALITY AS f (file_id, ord);
  DELETE FROM lms.assignment_uploads
   WHERE tenant_id = p_tenant AND assignment_item_id = p_item AND participant_id = g.participant_id
     AND file_id = ANY (file_ids);
  INSERT INTO lms.item_progress AS ip (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how)
  VALUES (p_tenant, g.participant_id, p_item, p_offering, 'completed', now(), 'submit')
  ON CONFLICT (tenant_id, participant_id, item_id) DO UPDATE SET
    status = 'completed',
    completed_at = coalesce(ip.completed_at, now()),
    completed_how = coalesce(ip.completed_how, 'submit'),
    last_activity_at = now();
  pct := lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, late);
  RETURN jsonb_build_object('result', 'ok', 'submissionId', new_id, 'versionNo', nver, 'lateSeconds', late,
                            'onGrace', grace, 'penaltyPercent', pct);
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_submit(uuid, uuid, uuid, uuid, uuid, text, text, uuid[], boolean, integer, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_submit(uuid, uuid, uuid, uuid, uuid, text, text, uuid[], boolean, integer, timestamptz, integer) TO lms_app;

-- ------------------------------------------------------------------ exams
DROP FUNCTION lms.attempt_save(uuid, uuid, uuid, uuid, jsonb, jsonb, integer);
CREATE FUNCTION lms.attempt_save(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid, p_answers jsonb, p_events jsonb,
                                 p_grace integer, p_arrival timestamptz DEFAULT NULL, p_max_age integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
  res jsonb;
  n_events integer;
  arr timestamptz := lms.effective_arrival(p_arrival, p_max_age);
BEGIN
  SELECT a.* INTO att FROM lms.attempts a
   WHERE a.tenant_id = p_tenant AND a.id = p_attempt AND a.offering_id = p_offering
     AND EXISTS (SELECT 1 FROM lms.course_participants cp
                   JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  WHERE cp.tenant_id = a.tenant_id AND cp.id = a.participant_id AND cp.status = 'active'
                    AND tm.user_id = p_user AND tm.status = 'active')
     FOR NO KEY UPDATE OF a;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF att.status <> 'in_progress' THEN RETURN jsonb_build_object('result', 'submitted'); END IF;
  -- the deadline is checked against when the request ARRIVED, not against how long it waited for this connection
  IF arr > att.deadline_at + make_interval(secs => p_grace) THEN
    PERFORM lms.attempts_finalize(ARRAY[p_tenant], ARRAY[att.id], 'deadline');
    RETURN jsonb_build_object('result', 'closed');
  END IF;

  IF jsonb_typeof(p_events) = 'array' AND jsonb_array_length(p_events) > 0 THEN
    INSERT INTO lms.attempt_events (tenant_id, attempt_id, n, at, kind)
    SELECT p_tenant, p_attempt, (att.event_count + e.ord)::smallint,
           CASE WHEN (e.v ->> 't') ~ '^[0-9]{10,14}$'
                     AND to_timestamp((e.v ->> 't')::numeric / 1000) BETWEEN now() - interval '1 day' AND now()
                THEN to_timestamp((e.v ->> 't')::numeric / 1000) ELSE now() END,
           e.v ->> 'k'
      FROM jsonb_array_elements(p_events) WITH ORDINALITY e(v, ord)
     WHERE e.ord <= 50 AND att.event_count + e.ord <= 300
       AND (e.v ->> 'k') IN ('hidden', 'visible', 'blur', 'focus', 'offline', 'online', 'resume');
    GET DIAGNOSTICS n_events = ROW_COUNT;
    IF n_events > 0 THEN
      UPDATE lms.attempts SET event_count = (event_count + n_events)::smallint WHERE tenant_id = p_tenant AND id = p_attempt;
    END IF;
  END IF;

  IF jsonb_typeof(p_answers) = 'array' AND jsonb_array_length(p_answers) > 0 THEN
    WITH inc AS (
      SELECT DISTINCT ON (p) p, a, rev, f, at, ms
        FROM (SELECT (e ->> 'p')::integer AS p,
                     CASE WHEN jsonb_typeof(e -> 'a') = 'object' THEN e -> 'a' END AS a,
                     (e ->> 'rev')::integer AS rev,
                     coalesce((e ->> 'f')::boolean, false) AS f,
                     coalesce((e ->> 'at')::bigint, 0) AS at,
                     least(greatest(coalesce((e ->> 'ms')::integer, 0), 0), 300000) AS ms
                FROM jsonb_array_elements(p_answers) WITH ORDINALITY x(e, ord) WHERE ord <= 100) q
       ORDER BY p, rev DESC, at DESC),
    upd AS (
      UPDATE lms.attempt_questions aq
         SET answer = inc.a, rev = inc.rev, client_at = inc.at, flagged = inc.f, answered_at = now(),
             spent_ms = least(aq.spent_ms + inc.ms, 2000000000)
        FROM inc
       WHERE aq.tenant_id = p_tenant AND aq.attempt_id = p_attempt AND aq.position = inc.p
         AND (aq.rev, aq.client_at) < (inc.rev, inc.at) AND inc.rev >= 1
         AND (inc.a IS NULL OR octet_length(inc.a::text) <= 60000)
      RETURNING aq.position)
    SELECT jsonb_build_object('applied', (SELECT count(*) FROM upd),
             'stale', coalesce((SELECT jsonb_agg(jsonb_build_object('position', aq.position, 'rev', aq.rev,
                                                                    'answer', aq.answer, 'flagged', aq.flagged))
                                  FROM inc JOIN lms.attempt_questions aq ON aq.tenant_id = p_tenant AND aq.attempt_id = p_attempt
                                                                          AND aq.position = inc.p
                                 WHERE inc.p NOT IN (SELECT position FROM upd)), '[]'::jsonb))
      INTO res;
  ELSE
    res := jsonb_build_object('applied', 0, 'stale', '[]'::jsonb);
  END IF;
  RETURN res || jsonb_build_object('result', 'ok', 'serverNow', now(), 'deadlineAt', att.deadline_at);
END
$$;
REVOKE ALL ON FUNCTION lms.attempt_save(uuid, uuid, uuid, uuid, jsonb, jsonb, integer, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_save(uuid, uuid, uuid, uuid, jsonb, jsonb, integer, timestamptz, integer) TO lms_app;

-- Submit had no deadline check of its own: it finalized whenever it came, labelled 'manual'. Now a hand-in that ARRIVED after
-- the deadline and its grace is labelled 'deadline' (what the sweeper does), one that arrived in time stays 'manual' however
-- long it waited for a connection. The score is the same either way (answers are saved by the autosave); the label is what
-- the instructor sees.
DROP FUNCTION lms.attempt_submit(uuid, uuid, uuid, uuid);
CREATE FUNCTION lms.attempt_submit(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid,
                                   p_grace integer DEFAULT 0, p_arrival timestamptz DEFAULT NULL,
                                   p_max_age integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
  arr timestamptz := lms.effective_arrival(p_arrival, p_max_age);
BEGIN
  SELECT a.* INTO att FROM lms.attempts a
   WHERE a.tenant_id = p_tenant AND a.id = p_attempt AND a.offering_id = p_offering
     AND EXISTS (SELECT 1 FROM lms.course_participants cp
                   JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  WHERE cp.tenant_id = a.tenant_id AND cp.id = a.participant_id AND cp.status = 'active'
                    AND tm.user_id = p_user AND tm.status = 'active')
     FOR UPDATE OF a;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF att.status = 'in_progress' THEN
    PERFORM lms.attempts_finalize(ARRAY[p_tenant], ARRAY[p_attempt],
      CASE WHEN arr > att.deadline_at + make_interval(secs => p_grace) THEN 'deadline' ELSE 'manual' END);
    SELECT * INTO att FROM lms.attempts WHERE tenant_id = p_tenant AND id = p_attempt;
  END IF;
  -- the second click / the other tab arrives here and gets the same answer
  RETURN jsonb_build_object('result', 'ok', 'status', att.status, 'submittedAt', att.submitted_at);
END
$$;
REVOKE ALL ON FUNCTION lms.attempt_submit(uuid, uuid, uuid, uuid, integer, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_submit(uuid, uuid, uuid, uuid, integer, timestamptz, integer) TO lms_app;

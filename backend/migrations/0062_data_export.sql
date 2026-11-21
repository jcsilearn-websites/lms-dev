-- Step 14b-1, part 2: "download my data". A member asks for an archive of their own data in ONE college; the worker builds it; they
-- download it within 7 days; it is deleted after that.
--
--   data_exports                  one row per request (state machine below). lms_app can only SELECT, and only the caller's own rows.
--   privacy_export_request        request (member active, one at a time per person, at most 3 a day) + its job + its audit row: ONE call
--   privacy_export_claim          the worker takes it (queued | building -> building)
--   privacy_export_collect        everything the archive holds, as one JSON document (the only reader of the person's data for this)
--   privacy_export_finish / _fail the result (ready | failed) + its audit row
--   privacy_export_download       the owner's download: checks owner + state + expiry, writes the audit row, returns the storage key
--   privacy_export_expire_list    due exports (ready past expiry, failed) -> state 'expired'; the worker deletes the objects, then
--   privacy_export_purged         clears the key (a crash in between is retried: deleting a missing object is not an error)
--
-- States: queued -> building -> ready -> expired;  queued | building -> failed -> expired (the row stays as the record that it happened).
-- Every state change and its audit row are written by the same function: one statement, one transaction (CLAUDE.md audit atomicity).
-- Functions take `p_now` (never now() for a decision): the expiry tests use explicit instants.

CREATE TABLE lms.data_exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  user_id uuid NOT NULL REFERENCES lms.users (id),
  status text NOT NULL CHECK (status IN ('queued', 'building', 'ready', 'failed', 'expired')),
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  size_bytes bigint,
  sha256 text,
  storage_key text,
  -- number of rows per section of the archive (numbers only: never a value)
  counts jsonb,
  -- a generic reason, never a stack trace or a value
  error text CHECK (length(error) <= 200),
  CONSTRAINT data_exports_member_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES lms.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT data_exports_ready_ck CHECK (status <> 'ready' OR (storage_key IS NOT NULL AND expires_at IS NOT NULL))
);
-- at most one request in progress per person and college (the function serialises, the index is the guarantee)
CREATE UNIQUE INDEX data_exports_one_active ON lms.data_exports (tenant_id, user_id) WHERE status IN ('queued', 'building');
CREATE INDEX data_exports_user_idx ON lms.data_exports (tenant_id, user_id, requested_at DESC, id);
CREATE INDEX data_exports_due_idx ON lms.data_exports (status, expires_at) WHERE status IN ('ready', 'failed', 'expired');

ALTER TABLE lms.data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.data_exports FORCE ROW LEVEL SECURITY;
-- a member sees their own rows only (not even an institution admin reads another person's exports)
CREATE POLICY data_exports_own ON lms.data_exports FOR SELECT TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()) AND user_id = (SELECT lms.current_user_id()));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.data_exports FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;
GRANT SELECT ON lms.data_exports TO lms_app;

-- ---------------------------------------------------------------- request
CREATE FUNCTION lms.privacy_export_request(p_tenant uuid, p_user uuid, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_row lms.data_exports;
BEGIN
  -- one request at a time per person: the second caller waits here, then sees the first one's row
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.export:' || p_user::text, 0));
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active') THEN
    RETURN jsonb_build_object('result', 'not_a_member');
  END IF;
  SELECT * INTO v_row FROM lms.data_exports e
   WHERE e.tenant_id = p_tenant AND e.user_id = p_user AND e.status IN ('queued', 'building');
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'in_progress', 'id', v_row.id, 'status', v_row.status, 'requestedAt', v_row.requested_at);
  END IF;
  IF (SELECT count(*) FROM lms.data_exports e
       WHERE e.tenant_id = p_tenant AND e.user_id = p_user
         AND e.requested_at > p_now - interval '24 hours' AND e.requested_at <= p_now) >= 3 THEN
    RETURN jsonb_build_object('result', 'too_many');
  END IF;
  v_id := lms.uuid_v7();
  INSERT INTO lms.data_exports (id, tenant_id, user_id, status, requested_at) VALUES (v_id, p_tenant, p_user, 'queued', p_now);
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
  VALUES (lms.uuid_v7(), 'privacy.export', p_tenant, jsonb_build_object('exportId', v_id), 3);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_user, 'privacy.export_requested', 'data_export', v_id::text,
          CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  RETURN jsonb_build_object('result', 'ok', 'id', v_id, 'status', 'queued', 'requestedAt', p_now);
END
$$;

-- ---------------------------------------------------------------- the worker: claim, collect, finish, fail
CREATE FUNCTION lms.privacy_export_claim(p_tenant uuid, p_id uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_row lms.data_exports;
BEGIN
  SELECT * INTO v_row FROM lms.data_exports e WHERE e.tenant_id = p_tenant AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_row.status NOT IN ('queued', 'building') THEN RETURN jsonb_build_object('result', 'skip', 'status', v_row.status); END IF;
  -- the person left the college (or was suspended) since asking: nothing is built
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.user_id = v_row.user_id AND m.status = 'active') THEN
    UPDATE lms.data_exports SET status = 'failed', error = 'no longer an active member' WHERE id = p_id;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.export_failed', 'data_export', p_id::text, jsonb_build_object('reason', 'not_active'));
    RETURN jsonb_build_object('result', 'skip', 'status', 'failed');
  END IF;
  UPDATE lms.data_exports SET status = 'building', started_at = coalesce(started_at, p_now) WHERE id = p_id;
  RETURN jsonb_build_object('result', 'ok', 'userId', v_row.user_id);
END
$$;

-- Everything the archive holds, about the person of ONE claimed export, in ONE college. Reads the person's OWN rows only: every
-- statement is filtered by the participants / memberships of that user in that tenant. Grades and quiz scores only when RELEASED
-- (the same rules the learner's own pages use: lms.results_visible, assignment_final_scores.released); never another person's data,
-- grader notes, override / waiver reasons, accommodation or extension reasons, the integrity log, the audit log, anything unreleased.
CREATE FUNCTION lms.privacy_export_collect(p_tenant uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp SET jit = off
AS $$
DECLARE
  v_user uuid;
  v_out jsonb;
BEGIN
  SELECT e.user_id INTO v_user FROM lms.data_exports e WHERE e.tenant_id = p_tenant AND e.id = p_id AND e.status = 'building';
  IF v_user IS NULL THEN RAISE EXCEPTION 'export is not being built' USING ERRCODE = '22023'; END IF;
  WITH mine AS MATERIALIZED (
    SELECT p.id AS pid, p.offering_id, p.participation::text AS participation, p.status::text AS pstatus, p.created_at AS since
      FROM lms.course_participants p
      JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id
     WHERE p.tenant_id = p_tenant AND m.user_id = v_user),
  offs AS MATERIALIZED (
    SELECT o.id, o.label, c.code AS course_code, c.title AS course_title, t.name AS term_name
      FROM lms.course_offerings o
      JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
      JOIN lms.terms t ON t.tenant_id = o.tenant_id AND t.id = o.term_id
     WHERE o.tenant_id = p_tenant AND o.id IN (SELECT offering_id FROM mine)),
  -- a LIMIT on every section: one person's data is small, a runaway is not allowed to fill the worker's memory
  sec_enrol AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'courseTitle', f.course_title, 'offering', f.label,
             'term', f.term_name, 'participation', mn.participation, 'status', mn.pstatus, 'since', mn.since) ORDER BY mn.since), '[]'::jsonb) AS j
      FROM (SELECT * FROM mine LIMIT 5000) mn JOIN offs f ON f.id = mn.offering_id),
  sec_progress AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'offering', f.label, 'item', ci.title,
             'status', ip.status, 'completedAt', ip.completed_at, 'completedHow', ip.completed_how,
             'watchedSeconds', ip.watched_seconds, 'firstSeenAt', ip.first_seen_at, 'lastActivityAt', ip.last_activity_at)
             ORDER BY ip.last_activity_at, ci.id), '[]'::jsonb) AS j
      FROM (SELECT ip0.* FROM lms.item_progress ip0 WHERE ip0.tenant_id = p_tenant AND ip0.participant_id IN (SELECT pid FROM mine)
             ORDER BY ip0.last_activity_at, ip0.item_id LIMIT 50000) ip
      JOIN lms.content_items ci ON ci.tenant_id = ip.tenant_id AND ci.id = ip.item_id
      JOIN offs f ON f.id = ip.offering_id),
  sec_quiz AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'offering', f.label, 'quiz', ci.title,
             'attempt', x.attempt_no, 'status', x.status, 'startedAt', x.started_at, 'submittedAt', x.submitted_at,
             'score', CASE WHEN x.visible THEN x.score END, 'maxScore', CASE WHEN x.visible THEN x.max_score END)
             ORDER BY x.started_at, x.id), '[]'::jsonb) AS j
      FROM (SELECT a.*, lms.results_visible(s.results_visibility,
                       CASE WHEN s.closes_at IS NULL THEN NULL
                            ELSE greatest(s.closes_at, coalesce(acc.extended_close_at, s.closes_at)) END, a.released_at) AND a.status = 'graded' AS visible
              FROM lms.attempts a
              JOIN lms.assessments s ON s.tenant_id = a.tenant_id AND s.item_id = a.assessment_item_id
              LEFT JOIN lms.assessment_accommodations acc ON acc.tenant_id = a.tenant_id
                   AND acc.assessment_item_id = a.assessment_item_id AND acc.participant_id = a.participant_id
             WHERE a.tenant_id = p_tenant AND a.participant_id IN (SELECT pid FROM mine)
             ORDER BY a.started_at, a.id LIMIT 20000) x
      JOIN lms.content_items ci ON ci.tenant_id = x.tenant_id AND ci.id = x.assessment_item_id
      JOIN offs f ON f.id = x.offering_id),
  sec_hand AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'offering', f.label, 'assignment', ci.title,
             'version', sb.version_no, 'submittedAt', sb.submitted_at, 'lateSeconds', sb.late_seconds,
             'text', sb.text_body, 'link', sb.link_url) ORDER BY sb.submitted_at, sb.id), '[]'::jsonb) AS j
      FROM (SELECT s0.* FROM lms.submissions s0 WHERE s0.tenant_id = p_tenant AND s0.participant_id IN (SELECT pid FROM mine)
             ORDER BY s0.submitted_at, s0.id LIMIT 20000) sb
      JOIN lms.content_items ci ON ci.tenant_id = sb.tenant_id AND ci.id = sb.assignment_item_id
      JOIN offs f ON f.id = sb.offering_id),
  sec_agrades AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'offering', f.label, 'assignment', ci.title,
             'rawScore', g.raw_score, 'penaltyPercent', g.penalty_percent, 'finalScore', g.score, 'maxScore', g.max_score,
             'feedback', gr.feedback) ORDER BY f.label, ci.title), '[]'::jsonb) AS j
      FROM offs f
      CROSS JOIN LATERAL lms.assignment_final_scores(p_tenant, f.id) g
      JOIN lms.content_items ci ON ci.tenant_id = p_tenant AND ci.id = g.item_id
      JOIN lms.assignment_grades gr ON gr.tenant_id = p_tenant AND gr.assignment_item_id = g.item_id AND gr.participant_id = g.participant_id
     WHERE g.participant_id IN (SELECT pid FROM mine) AND g.released),
  sec_grades AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('courseCode', f.course_code, 'offering', f.label, 'version', v.version_no,
             'lockedAt', v.locked_at, 'finalMarks', r.final_marks, 'finalPercent', r.final_percent, 'grade', r.grade, 'isPass', r.is_pass)
             ORDER BY v.locked_at, r.participant_id), '[]'::jsonb) AS j
      FROM lms.gradebook_snapshot_rows r
      JOIN lms.gradebook_versions v ON v.tenant_id = r.tenant_id AND v.id = r.version_id
      JOIN lms.gradebooks g ON g.tenant_id = v.tenant_id AND g.id = v.gradebook_id
      JOIN offs f ON f.id = g.offering_id
     WHERE r.tenant_id = p_tenant AND r.participant_id IN (SELECT pid FROM mine)),
  sec_activity AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'firstAt', d.first_at) ORDER BY d.day), '[]'::jsonb) AS j
      FROM (SELECT * FROM lms.member_activity_days a WHERE a.tenant_id = p_tenant AND a.user_id = v_user ORDER BY a.day LIMIT 5000) d),
  sec_prefs AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('category', p.category, 'email', p.email, 'inApp', p.in_app) ORDER BY p.category), '[]'::jsonb) AS j
      FROM lms.notification_preferences p WHERE p.tenant_id = p_tenant AND p.user_id = v_user),
  sec_notes AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('category', n.category, 'type', n.type, 'createdAt', n.created_at, 'readAt', n.read_at)
             ORDER BY n.created_at, n.id), '[]'::jsonb) AS j
      FROM (SELECT * FROM lms.notifications x WHERE x.tenant_id = p_tenant AND x.user_id = v_user ORDER BY x.created_at, x.id LIMIT 5000) n)
  SELECT jsonb_build_object(
    'account', (SELECT jsonb_build_object('email', u.email, 'displayName', u.display_name, 'accountCreatedAt', u.created_at)
                  FROM lms.users u WHERE u.id = v_user),
    'membership', (SELECT jsonb_build_object('role', m.role, 'status', m.status, 'since', m.created_at)
                     FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = v_user),
    'profile', (SELECT jsonb_build_object('type', mp.profile_type, 'registerNumber', mp.register_number, 'employeeId', mp.employee_id,
                  'phone', mp.phone, 'designation', mp.designation, 'department', d.name, 'program', pr.name,
                  'batchAdmissionYear', b.admission_year, 'section', sc.code)
                  FROM lms.member_profiles mp
                  JOIN lms.tenant_memberships m ON m.tenant_id = mp.tenant_id AND m.id = mp.membership_id
                  LEFT JOIN lms.departments d ON d.tenant_id = mp.tenant_id AND d.id = mp.department_id
                  LEFT JOIN lms.batches b ON b.tenant_id = mp.tenant_id AND b.id = mp.batch_id
                  LEFT JOIN lms.programs pr ON pr.tenant_id = b.tenant_id AND pr.id = b.program_id
                  LEFT JOIN lms.sections sc ON sc.tenant_id = mp.tenant_id AND sc.id = mp.section_id
                 WHERE mp.tenant_id = p_tenant AND m.user_id = v_user),
    'enrolments', (SELECT j FROM sec_enrol),
    'progress', (SELECT j FROM sec_progress),
    'quizAttempts', (SELECT j FROM sec_quiz),
    'assignmentSubmissions', (SELECT j FROM sec_hand),
    'assignmentGrades', (SELECT j FROM sec_agrades),
    'courseGrades', (SELECT j FROM sec_grades),
    'activityDays', (SELECT j FROM sec_activity),
    'notificationPreferences', (SELECT j FROM sec_prefs),
    'notifications', (SELECT j FROM sec_notes)) INTO v_out;
  RETURN v_out;
END
$$;

CREATE FUNCTION lms.privacy_export_finish(p_tenant uuid, p_id uuid, p_key text, p_size bigint, p_sha256 text, p_counts jsonb,
                                          p_now timestamptz, p_ttl_seconds integer)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM lms.data_exports WHERE tenant_id = p_tenant AND id = p_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'building' THEN RETURN coalesce(v_status, 'not_found'); END IF;
  UPDATE lms.data_exports
     SET status = 'ready', storage_key = p_key, size_bytes = p_size, sha256 = p_sha256, counts = p_counts,
         ready_at = p_now, expires_at = p_now + make_interval(secs => p_ttl_seconds)
   WHERE id = p_id;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.export_ready', 'data_export', p_id::text,
          jsonb_build_object('bytes', p_size, 'expiresAt', p_now + make_interval(secs => p_ttl_seconds)));
  RETURN 'ready';
END
$$;

CREATE FUNCTION lms.privacy_export_fail(p_tenant uuid, p_id uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM lms.data_exports WHERE tenant_id = p_tenant AND id = p_id FOR UPDATE;
  IF v_status IS NULL OR v_status NOT IN ('queued', 'building') THEN RETURN coalesce(v_status, 'not_found'); END IF;
  UPDATE lms.data_exports SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 200) WHERE id = p_id;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.export_failed', 'data_export', p_id::text, jsonb_build_object('reason', 'build_failed'));
  RETURN 'failed';
END
$$;

-- ---------------------------------------------------------------- the owner's download
CREATE FUNCTION lms.privacy_export_download(p_tenant uuid, p_user uuid, p_id uuid, p_now timestamptz, p_ip inet)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_row lms.data_exports;
BEGIN
  -- somebody else's export, another college's, an unknown id: all "not found"
  SELECT * INTO v_row FROM lms.data_exports e WHERE e.tenant_id = p_tenant AND e.user_id = p_user AND e.id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_row.status IN ('queued', 'building') THEN RETURN jsonb_build_object('result', 'not_ready'); END IF;
  IF v_row.status <> 'ready' OR v_row.expires_at <= p_now THEN RETURN jsonb_build_object('result', 'expired'); END IF;
  -- the person must still be an active member
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active') THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_user, 'privacy.export_downloaded', 'data_export', p_id::text,
          CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  RETURN jsonb_build_object('result', 'ok', 'key', v_row.storage_key, 'expiresAt', v_row.expires_at);
END
$$;

-- ---------------------------------------------------------------- expiry: mark, delete the objects, clear the keys
CREATE FUNCTION lms.privacy_export_expire_list(p_now timestamptz, p_limit integer)
RETURNS TABLE (r_id uuid, r_tenant uuid, r_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id FROM lms.data_exports e
     WHERE (e.status = 'ready' AND e.expires_at <= p_now) OR (e.status IN ('failed', 'expired') AND e.storage_key IS NOT NULL)
     ORDER BY e.id LIMIT least(greatest(p_limit, 1), 500) FOR UPDATE SKIP LOCKED),
  mark AS (
    UPDATE lms.data_exports e SET status = 'expired' FROM due WHERE e.id = due.id AND e.status <> 'expired' RETURNING e.id)
  SELECT e.id, e.tenant_id, e.storage_key FROM lms.data_exports e JOIN due ON due.id = e.id WHERE e.storage_key IS NOT NULL;
END
$$;

CREATE FUNCTION lms.privacy_export_purged(p_ids uuid[])
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH u AS (UPDATE lms.data_exports SET storage_key = NULL WHERE id = ANY (p_ids) AND status = 'expired' RETURNING 1)
  SELECT count(*)::integer FROM u
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'privacy_export_request(uuid, uuid, inet, timestamptz)',
    'privacy_export_claim(uuid, uuid, timestamptz)',
    'privacy_export_collect(uuid, uuid)',
    'privacy_export_finish(uuid, uuid, text, bigint, text, jsonb, timestamptz, integer)',
    'privacy_export_fail(uuid, uuid, text)',
    'privacy_export_download(uuid, uuid, uuid, timestamptz, inet)',
    'privacy_export_expire_list(timestamptz, integer)',
    'privacy_export_purged(uuid[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

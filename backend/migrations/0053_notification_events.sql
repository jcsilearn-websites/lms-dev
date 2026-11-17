-- Step 13: notifications and email. Part 2: where events come from.
--   * triggers (same transaction as the change, zero extra round trips): security mail from the audit rows the auth / member /
--     platform functions already write; grades released; quiz results visible; extensions and accommodations; gradebook
--     workflow; video processed; import finished; usage month closed; content that became visible (a mark for the digest).
--   * the scan (worker, every NOTIFY_SCAN_SECONDS, ONE statement per college): deadline reminders, quizzes opening / closing,
--     results that became visible by the clock, the daily digests and the weekly summaries, in the college's time zone.
-- Every audience is selected set-based and handed to lms.notify_fanout in ONE call. Nothing here carries a mark, a score, a
-- feedback text or a reason: titles, counts, dates and links only (sentinel test: notifications.privacy.test.ts).

-- ------------------------------------------------------------------ helpers
-- The title learners see for an offering (the offering's override or the course title).
CREATE FUNCTION lms.notify_offering_title(p_tenant uuid, p_offering uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(o.title_override, c.title) FROM lms.course_offerings o
    JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
   WHERE o.tenant_id = p_tenant AND o.id = p_offering
$$;
REVOKE ALL ON FUNCTION lms.notify_offering_title(uuid, uuid) FROM PUBLIC;

-- ------------------------------------------------------------------ security mail from the audit log
-- The auth, member and platform functions already write ONE audit row in the same transaction as the change; the email is
-- queued from that row (no extra round trip, and it commits or rolls back with the change). The mapping is pinned by a test.
CREATE FUNCTION lms.notify_from_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF TG_TABLE_NAME = 'platform_audit_log' THEN
    -- admin host: only the password events (the college events are written to the college's log too)
    IF NEW.action IN ('auth.password_changed', 'auth.password_reset') THEN
      PERFORM lms.email_enqueue_security(NULL, NEW.target_id::uuid, 'password_changed', '{}'::jsonb, 'pwchanged:' || NEW.id);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.action IN ('auth.password_changed', 'auth.password_reset') THEN
    PERFORM lms.email_enqueue_security(NEW.tenant_id, NEW.target_id::uuid, 'password_changed', '{}'::jsonb, 'pwchanged:' || NEW.id);
  ELSIF NEW.action IN ('auth.invite_created', 'member.invite_resent') THEN
    SELECT m.user_id INTO v_user FROM lms.tenant_memberships m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.target_id::uuid;
    IF v_user IS NOT NULL THEN
      PERFORM lms.email_enqueue_security(NEW.tenant_id, v_user, 'invite', jsonb_build_object('membershipId', NEW.target_id),
                                         'invite:' || NEW.id);
    END IF;
  ELSIF NEW.action = 'platform.tenant_admin_invited' THEN
    SELECT m.user_id INTO v_user FROM lms.tenant_memberships m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.target_id::uuid;
    IF v_user IS NOT NULL AND NEW.metadata ->> 'outcome' = 'invited' THEN
      PERFORM lms.email_enqueue_security(NEW.tenant_id, v_user, 'invite', jsonb_build_object('membershipId', NEW.target_id),
                                         'invite:' || NEW.id);
    ELSIF v_user IS NOT NULL AND NEW.metadata ->> 'outcome' = 'promoted' THEN
      PERFORM lms.email_enqueue_security(NEW.tenant_id, v_user, 'admin_promoted', '{}'::jsonb, 'promoted:' || NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_from_audit() FROM PUBLIC;
CREATE TRIGGER audit_log_notify AFTER INSERT ON lms.audit_log FOR EACH ROW
  WHEN (NEW.action IN ('auth.password_changed', 'auth.password_reset', 'auth.invite_created', 'member.invite_resent',
                       'platform.tenant_admin_invited'))
  EXECUTE FUNCTION lms.notify_from_audit();
CREATE TRIGGER platform_audit_log_notify AFTER INSERT ON lms.platform_audit_log FOR EACH ROW
  WHEN (NEW.action IN ('auth.password_changed', 'auth.password_reset'))
  EXECUTE FUNCTION lms.notify_from_audit();

-- ------------------------------------------------------------------ assignment grades released ("your work was returned")
-- Visible to the learner = released, or saved under release_mode 'immediate'. ONE notification per handed-in version, whether
-- or not there is feedback (hasFeedback only changes the wording). Statement level: a release of 500 grades is one fan-out.
CREATE FUNCTION lms.notify_grades()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(ROW(n.tenant_id, m.user_id, 'learning_grades', 'grade_released',
                         jsonb_build_object('course', lms.notify_offering_title(n.tenant_id, a.offering_id), 'item', i.title,
                                            'kind', 'assignment', 'hasFeedback', (n.feedback IS NOT NULL OR n.rubric_selection IS NOT NULL)),
                         '/offerings/' || a.offering_id || '/items/' || n.assignment_item_id || '/assignment',
                         'grade:' || n.assignment_item_id || ':' || n.participant_id || ':' || n.submission_id,
                         'grade_released', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM new_rows n
      JOIN lms.assignments a ON a.tenant_id = n.tenant_id AND a.item_id = n.assignment_item_id
      JOIN lms.content_items i ON i.tenant_id = n.tenant_id AND i.id = n.assignment_item_id
      JOIN lms.course_participants p ON p.tenant_id = n.tenant_id AND p.id = n.participant_id AND p.status = 'active'
      JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
     WHERE n.released_at IS NOT NULL OR a.release_mode = 'immediate';
  ELSE
    SELECT array_agg(ROW(n.tenant_id, m.user_id, 'learning_grades', 'grade_released',
                         jsonb_build_object('course', lms.notify_offering_title(n.tenant_id, a.offering_id), 'item', i.title,
                                            'kind', 'assignment', 'hasFeedback', (n.feedback IS NOT NULL OR n.rubric_selection IS NOT NULL)),
                         '/offerings/' || a.offering_id || '/items/' || n.assignment_item_id || '/assignment',
                         'grade:' || n.assignment_item_id || ':' || n.participant_id || ':' || n.submission_id,
                         'grade_released', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM new_rows n
      JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.assignment_item_id = n.assignment_item_id
                     AND o.participant_id = n.participant_id
      JOIN lms.assignments a ON a.tenant_id = n.tenant_id AND a.item_id = n.assignment_item_id
      JOIN lms.content_items i ON i.tenant_id = n.tenant_id AND i.id = n.assignment_item_id
      JOIN lms.course_participants p ON p.tenant_id = n.tenant_id AND p.id = n.participant_id AND p.status = 'active'
      JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
     WHERE (n.released_at IS NOT NULL AND o.released_at IS NULL)
        OR (a.release_mode = 'immediate' AND n.submission_id IS DISTINCT FROM o.submission_id)
        OR (n.released_at IS NOT NULL AND n.submission_id IS DISTINCT FROM o.submission_id);
  END IF;
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_grades() FROM PUBLIC;
CREATE TRIGGER assignment_grades_notify_ins AFTER INSERT ON lms.assignment_grades
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.notify_grades();
CREATE TRIGGER assignment_grades_notify_upd AFTER UPDATE ON lms.assignment_grades
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.notify_grades();

-- ------------------------------------------------------------------ quiz results that became visible by a change
-- manual: released; immediate: graded LATER than the submit (essays graded by hand; an auto-graded attempt shows its result on
-- the spot, so no message); after_close: graded after the close. Visibility by the CLOCK (the close passing) is the scan's job.
CREATE FUNCTION lms.notify_results()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
BEGIN
  SELECT array_agg(ROW(n.tenant_id, m.user_id, 'learning_grades', 'grade_released',
                       jsonb_build_object('course', lms.notify_offering_title(n.tenant_id, n.offering_id), 'item', i.title,
                                          'kind', 'assessment', 'hasFeedback', false),
                       '/offerings/' || n.offering_id || '/attempts/' || n.id || '/result',
                       'results:' || n.id, 'grade_released', NULL::timestamptz, true)::lms.notify_item)
    INTO items
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
    JOIN lms.assessments s ON s.tenant_id = n.tenant_id AND s.item_id = n.assessment_item_id
    JOIN lms.content_items i ON i.tenant_id = n.tenant_id AND i.id = n.assessment_item_id
    JOIN lms.course_participants p ON p.tenant_id = n.tenant_id AND p.id = n.participant_id AND p.status = 'active'
    JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
    LEFT JOIN lms.assessment_accommodations ac
      ON ac.tenant_id = n.tenant_id AND ac.assessment_item_id = n.assessment_item_id AND ac.participant_id = n.participant_id
   WHERE n.status = 'graded'
     AND ((s.results_visibility = 'manual' AND n.released_at IS NOT NULL AND o.released_at IS NULL)
       OR (s.results_visibility = 'immediate' AND o.status = 'submitted')
       OR (s.results_visibility = 'after_close' AND o.status <> 'graded'
           AND now() >= coalesce(ac.extended_close_at, s.closes_at)));
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_results() FROM PUBLIC;
CREATE TRIGGER attempts_notify AFTER UPDATE ON lms.attempts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.notify_results();

-- ------------------------------------------------------------------ extensions and accommodations (never the reason)
CREATE FUNCTION lms.notify_adjustment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
  v_item uuid;
  v_kind text;
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'assignment_extensions' THEN
    IF TG_OP = 'UPDATE' AND OLD.extended_due_at = NEW.extended_due_at THEN RETURN NULL; END IF;
    v_item := NEW.assignment_item_id;
    v_kind := 'extension_granted';
    v_key := 'ext:' || v_item || ':' || NEW.participant_id || ':' || floor(extract(epoch FROM NEW.extended_due_at))::bigint;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.extra_minutes = NEW.extra_minutes
       AND OLD.extended_close_at IS NOT DISTINCT FROM NEW.extended_close_at THEN
      RETURN NULL;
    END IF;
    v_item := NEW.assessment_item_id;
    v_kind := 'accommodation_updated';
    v_key := 'acc:' || v_item || ':' || NEW.participant_id || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint;
  END IF;
  SELECT array_agg(ROW(p.tenant_id, m.user_id, 'learning_deadlines', v_kind,
                       jsonb_build_object('course', lms.notify_offering_title(p.tenant_id, p.offering_id), 'item', i.title),
                       '/offerings/' || p.offering_id || '/items/' || v_item, v_key, v_kind, NULL::timestamptz,
                       true)::lms.notify_item)
    INTO items
    FROM lms.course_participants p
    JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
    JOIN lms.content_items i ON i.tenant_id = p.tenant_id AND i.id = v_item
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.participant_id AND p.status = 'active';
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_adjustment() FROM PUBLIC;
CREATE TRIGGER assignment_extensions_notify AFTER INSERT OR UPDATE ON lms.assignment_extensions
  FOR EACH ROW EXECUTE FUNCTION lms.notify_adjustment();
CREATE TRIGGER assessment_accommodations_notify AFTER INSERT OR UPDATE ON lms.assessment_accommodations
  FOR EACH ROW EXECUTE FUNCTION lms.notify_adjustment();

-- ------------------------------------------------------------------ gradebook workflow (never the review comment)
-- submitted -> the college's institution admins (admin); returned / approved -> the offering's instructors (teaching_grading),
-- except whoever acted.
CREATE FUNCTION lms.notify_gradebook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
  v_offering uuid;
  v_title text;
BEGIN
  SELECT g.offering_id INTO v_offering FROM lms.gradebooks g WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.gradebook_id;
  v_title := lms.notify_offering_title(NEW.tenant_id, v_offering);
  IF NEW.action = 'submitted' THEN
    SELECT array_agg(ROW(m.tenant_id, m.user_id, 'admin', 'gradebook_submitted',
                         jsonb_build_object('course', v_title, 'version', NEW.version_no),
                         '/gradebooks', 'gbsub:' || NEW.id, 'gradebook_submitted', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM lms.tenant_memberships m
     WHERE m.tenant_id = NEW.tenant_id AND m.role = 'institution_admin' AND m.status = 'active'
       AND m.user_id <> NEW.actor_user_id;
  ELSIF NEW.action IN ('returned', 'approved') THEN
    SELECT array_agg(ROW(p.tenant_id, m.user_id, 'teaching_grading', 'gradebook_' || NEW.action,
                         jsonb_build_object('course', v_title, 'version', NEW.version_no),
                         '/offerings/' || v_offering || '/gradebook', 'gb:' || NEW.id, 'gradebook_' || NEW.action,
                         NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM lms.course_participants p
      JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
     WHERE p.tenant_id = NEW.tenant_id AND p.offering_id = v_offering AND p.participation = 'instructor'
       AND p.status = 'active' AND m.user_id <> NEW.actor_user_id;
  END IF;
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_gradebook() FROM PUBLIC;
CREATE TRIGGER gradebook_events_notify AFTER INSERT ON lms.gradebook_events
  FOR EACH ROW EXECUTE FUNCTION lms.notify_gradebook();

-- ------------------------------------------------------------------ video processed / failed (to the uploader)
CREATE FUNCTION lms.notify_video()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
BEGIN
  IF NEW.status NOT IN ('ready', 'failed') OR OLD.status = NEW.status THEN RETURN NULL; END IF;
  SELECT array_agg(ROW(NEW.tenant_id, m.user_id, 'teaching_updates', 'video_' || NEW.status,
                       jsonb_build_object('course', lms.notify_offering_title(NEW.tenant_id, NEW.offering_id),
                                          'name', NEW.original_name),
                       '/offerings/' || NEW.offering_id || '/build', 'video:' || NEW.id || ':' || NEW.status,
                       'video_' || NEW.status, NULL::timestamptz, true)::lms.notify_item)
    INTO items
    FROM lms.tenant_memberships m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.created_by AND m.status = 'active';
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_video() FROM PUBLIC;
CREATE TRIGGER video_assets_notify AFTER UPDATE OF status ON lms.video_assets
  FOR EACH ROW EXECUTE FUNCTION lms.notify_video();

-- ------------------------------------------------------------------ import finished (to whoever started it)
CREATE FUNCTION lms.notify_import()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  items lms.notify_item[];
BEGIN
  IF OLD.status = NEW.status OR NEW.status::text NOT IN ('completed', 'completed_with_errors', 'failed')
     OR OLD.status::text NOT IN ('queued', 'processing') THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(ROW(NEW.tenant_id, m.user_id, 'admin', 'import_finished',
                       jsonb_build_object('fileName', NEW.file_name, 'status', NEW.status::text,
                                          'processed', NEW.processed_rows, 'failed', NEW.failed_rows),
                       '/imports/' || NEW.id, 'import:' || NEW.id, 'import_finished', NULL::timestamptz, true)::lms.notify_item)
    INTO items
    FROM lms.tenant_memberships m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.created_by_user_id AND m.status = 'active';
  PERFORM lms.notify_fanout(items);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_import() FROM PUBLIC;
CREATE TRIGGER import_jobs_notify AFTER UPDATE OF status ON lms.import_jobs
  FOR EACH ROW EXECUTE FUNCTION lms.notify_import();

-- ------------------------------------------------------------------ usage month closed (platform admins)
-- One message per platform admin per closing statement (colleges close at different hours, each in its own zone).
CREATE FUNCTION lms.notify_usage_closed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_month date;
  v_count integer;
  v_key text;
BEGIN
  SELECT min(n.month), count(*) INTO v_month, v_count FROM new_rows n WHERE n.revision = 1;
  IF coalesce(v_count, 0) = 0 THEN RETURN NULL; END IF;
  v_key := 'usage:' || v_month || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint;
  INSERT INTO lms.platform_notifications (id, user_id, type, params, link, dedupe_key)
  SELECT lms.uuid_v7(), u.id, 'usage_closed', jsonb_build_object('month', v_month, 'colleges', v_count), '/usage', v_key
    FROM lms.users u WHERE u.is_platform_admin
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  WITH ins AS (
    INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params)
    SELECT lms.uuid_v7(), NULL, v_key || ':' || u.id, u.id, u.email, 'admin', 'usage_closed',
           jsonb_build_object('month', v_month, 'colleges', v_count, 'link', '/usage')
      FROM lms.users u WHERE u.is_platform_admin AND NOT lms.email_suppressed(u.email, 'admin')
    ON CONFLICT ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key) DO NOTHING
    RETURNING id)
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
  SELECT lms.uuid_v7(), 'email.send', NULL, jsonb_build_object('outboxId', ins.id), now(), 5, 'email:' || ins.id FROM ins;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_usage_closed() FROM PUBLIC;
CREATE TRIGGER usage_snapshots_notify AFTER INSERT ON lms.usage_snapshots
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.notify_usage_closed();

-- ------------------------------------------------------------------ content that became visible -> a mark for the digest
-- visible_at = when learners can first see it (now, or a future available_from of the item or its module). The daily digest
-- reads the marks whose moment has come and deletes them; it re-checks visibility then (an item hidden again is skipped).
CREATE FUNCTION lms.notify_mark_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'content_items' THEN
    IF NOT NEW.published OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND OLD.published AND OLD.available_from IS NOT DISTINCT FROM NEW.available_from THEN RETURN NULL; END IF;
    INSERT INTO lms.notify_content_marks (tenant_id, item_id, offering_id, visible_at)
    SELECT NEW.tenant_id, NEW.id, NEW.offering_id, greatest(now(), NEW.available_from, md.available_from)
      FROM lms.content_modules md WHERE md.tenant_id = NEW.tenant_id AND md.id = NEW.module_id
    ON CONFLICT (tenant_id, item_id) DO UPDATE SET visible_at = EXCLUDED.visible_at;
  ELSE
    -- a module published (or its date moved): its published items become visible
    IF NOT NEW.published OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
    IF OLD.published AND OLD.available_from IS NOT DISTINCT FROM NEW.available_from THEN RETURN NULL; END IF;
    INSERT INTO lms.notify_content_marks (tenant_id, item_id, offering_id, visible_at)
    SELECT i.tenant_id, i.id, i.offering_id, greatest(now(), i.available_from, NEW.available_from)
      FROM lms.content_items i
     WHERE i.tenant_id = NEW.tenant_id AND i.module_id = NEW.id AND i.published AND i.deleted_at IS NULL
    ON CONFLICT (tenant_id, item_id) DO UPDATE SET visible_at = EXCLUDED.visible_at;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_mark_content() FROM PUBLIC;
CREATE TRIGGER content_items_notify AFTER INSERT OR UPDATE OF published, available_from ON lms.content_items
  FOR EACH ROW EXECUTE FUNCTION lms.notify_mark_content();
CREATE TRIGGER content_modules_notify AFTER UPDATE OF published, available_from ON lms.content_modules
  FOR EACH ROW EXECUTE FUNCTION lms.notify_mark_content();

-- ------------------------------------------------------------------ indexes for the scan (lead with tenant_id)
CREATE INDEX assignments_due_idx ON lms.assignments (tenant_id, due_at) WHERE due_at IS NOT NULL;
CREATE INDEX assessments_opens_idx ON lms.assessments (tenant_id, opens_at) WHERE opens_at IS NOT NULL;
CREATE INDEX assessments_closes_idx ON lms.assessments (tenant_id, closes_at) WHERE closes_at IS NOT NULL;
CREATE INDEX assignment_extensions_due_idx ON lms.assignment_extensions (tenant_id, extended_due_at);
CREATE INDEX assessment_accommodations_close_idx ON lms.assessment_accommodations (tenant_id, extended_close_at)
  WHERE extended_close_at IS NOT NULL;

-- ------------------------------------------------------------------ the scan: one college, one statement
-- Acts on every threshold that fell in (scanned_until, p_now] (at most 24 h back: a worker that was down a week does not send a
-- week of stale reminders), then on the daily / weekly runs whose local time has come. Idempotent: a repeated window only hits
-- ON CONFLICT. Returns {"reminders": n, "digests": n, ...} (jobs enqueued per kind).
CREATE FUNCTION lms.notify_scan_tenant(p_tenant uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp SET jit = off
AS $$
DECLARE
  v_from timestamptz;
  v_s jsonb := lms.notify_settings(p_tenant);
  v_tz text := lms.tenant_tz(p_tenant);
  v_local timestamp := p_now AT TIME ZONE v_tz;
  v_date date := (p_now AT TIME ZONE v_tz)::date;
  v_digest_hour integer := least(greatest(coalesce((v_s ->> 'digestHour')::int, 7), 0), 23);
  items lms.notify_item[];
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_health boolean;
  v_weeks integer;
  v_backlog integer;
BEGIN
  SELECT st.scanned_until INTO v_from FROM lms.notify_scan_state st WHERE st.tenant_id = p_tenant FOR UPDATE;
  v_from := greatest(coalesce(v_from, p_now - interval '5 minutes'), p_now - interval '24 hours');
  IF v_from >= p_now THEN RETURN v_out; END IF;

  -- -------------------------------------------------- assignment due reminders (24 h and 1 h), only to non-submitters
  -- LINEAR WITHOUT STATISTICS (a new college has none: the planner then believes every table has one row): the few assignments
  -- whose threshold is in the window are found and checked FIRST (one row per assignment, run once: MATERIALIZED, the college's
  -- course title looked up once per assignment, not per learner); the learners are then reached through a LATERAL probe of the
  -- offering's participants (OFFSET 0 keeps the planner from re-ordering), and every per-learner check is a unique-key probe.
  WITH win AS MATERIALIZED (
    SELECT a.item_id, a.offering_id, a.due_at AS due, i.title, lms.notify_offering_title(p_tenant, a.offering_id) AS course,
           CASE WHEN a.due_at - interval '1 hour' > v_from AND a.due_at - interval '1 hour' <= p_now AND p_now < a.due_at THEN 1
                WHEN a.due_at - interval '24 hours' > v_from AND a.due_at - interval '24 hours' <= p_now
                     AND p_now < a.due_at - interval '1 hour' THEN 24 END AS hours
      FROM lms.assignments a
      JOIN lms.content_items i ON i.tenant_id = p_tenant AND i.id = a.item_id AND i.published AND i.deleted_at IS NULL
      JOIN lms.content_modules md ON md.tenant_id = p_tenant AND md.id = i.module_id AND md.published AND md.deleted_at IS NULL
      JOIN lms.course_offerings o ON o.tenant_id = p_tenant AND o.id = a.offering_id AND o.status = 'published'
     WHERE a.tenant_id = p_tenant AND a.due_at > v_from + interval '1 hour' AND a.due_at <= p_now + interval '24 hours'
       AND coalesce(greatest(i.available_from, md.available_from), '-infinity'::timestamptz) <= p_now),
  ext AS MATERIALIZED (
    -- learners with an extension: their own due date (a handful of rows)
    SELECT a.item_id, a.offering_id, e.extended_due_at AS due, i.title, e.participant_id,
           lms.notify_offering_title(p_tenant, a.offering_id) AS course,
           CASE WHEN e.extended_due_at - interval '1 hour' > v_from AND e.extended_due_at - interval '1 hour' <= p_now
                     AND p_now < e.extended_due_at THEN 1
                WHEN e.extended_due_at - interval '24 hours' > v_from AND e.extended_due_at - interval '24 hours' <= p_now
                     AND p_now < e.extended_due_at - interval '1 hour' THEN 24 END AS hours
      FROM lms.assignment_extensions e
      JOIN lms.assignments a ON a.tenant_id = p_tenant AND a.item_id = e.assignment_item_id
      JOIN lms.content_items i ON i.tenant_id = p_tenant AND i.id = a.item_id AND i.published AND i.deleted_at IS NULL
      JOIN lms.content_modules md ON md.tenant_id = p_tenant AND md.id = i.module_id AND md.published AND md.deleted_at IS NULL
      JOIN lms.course_offerings o ON o.tenant_id = p_tenant AND o.id = a.offering_id AND o.status = 'published'
     WHERE e.tenant_id = p_tenant AND e.extended_due_at > v_from + interval '1 hour'
       AND e.extended_due_at <= p_now + interval '24 hours'
       AND coalesce(greatest(i.available_from, md.available_from), '-infinity'::timestamptz) <= p_now),
  cand AS MATERIALIZED (
    SELECT w.item_id, w.offering_id, w.due, w.title, w.course, w.hours, p.id AS participant_id, p.membership_id
      FROM win w
      CROSS JOIN LATERAL (SELECT pp.id, pp.membership_id FROM lms.course_participants pp
                           WHERE pp.tenant_id = p_tenant AND pp.offering_id = w.offering_id
                             AND pp.participation = 'learner' AND pp.status = 'active' OFFSET 0) p
     WHERE w.hours IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lms.assignment_extensions e WHERE e.tenant_id = p_tenant
                         AND e.assignment_item_id = w.item_id AND e.participant_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.assignment_item_id = w.item_id
                         AND s.participant_id = p.id)
    UNION ALL
    SELECT x.item_id, x.offering_id, x.due, x.title, x.course, x.hours, p.id, p.membership_id
      FROM ext x
      CROSS JOIN LATERAL (SELECT pp.id, pp.membership_id FROM lms.course_participants pp
                           WHERE pp.tenant_id = p_tenant AND pp.id = x.participant_id
                             AND pp.participation = 'learner' AND pp.status = 'active' OFFSET 0) p
     WHERE x.hours IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.assignment_item_id = x.item_id
                         AND s.participant_id = p.id))
  SELECT array_agg(ROW(p_tenant, m.user_id, 'learning_deadlines', 'due_soon',
                       jsonb_build_object('course', c.course, 'item', c.title, 'hours', c.hours, 'dueAt', c.due),
                       '/offerings/' || c.offering_id || '/items/' || c.item_id || '/assignment',
                       'due' || c.hours || ':' || c.item_id || ':' || c.participant_id || ':' || floor(extract(epoch FROM c.due))::bigint,
                       'due_reminder', c.due, true)::lms.notify_item)
    INTO items
    FROM cand c
    CROSS JOIN LATERAL (SELECT mm.user_id FROM lms.tenant_memberships mm
                         WHERE mm.tenant_id = p_tenant AND mm.id = c.membership_id AND mm.status = 'active' OFFSET 0) m;
  v_n := lms.notify_fanout(items);
  v_out := v_out || jsonb_build_object('assignmentReminders', coalesce(cardinality(items), 0));

  -- -------------------------------------------------- quizzes: opening in 1 h; closing in 24 h / 1 h (not yet submitted)
  -- the same shape: the assessments whose threshold may be in the window first (an accommodation can move one learner's close,
  -- so an assessment with such an accommodation in the window counts too), then the learners by a LATERAL probe
  WITH qwin AS MATERIALIZED (
    SELECT s.item_id, s.offering_id, s.opens_at, s.closes_at, i.title,
           lms.notify_offering_title(p_tenant, s.offering_id) AS course,
           coalesce(greatest(i.available_from, md.available_from), '-infinity'::timestamptz) AS visible_from
      FROM lms.assessments s
      JOIN lms.content_items i ON i.tenant_id = p_tenant AND i.id = s.item_id AND i.published AND i.deleted_at IS NULL
      JOIN lms.content_modules md ON md.tenant_id = p_tenant AND md.id = i.module_id AND md.published AND md.deleted_at IS NULL
      JOIN lms.course_offerings o ON o.tenant_id = p_tenant AND o.id = s.offering_id AND o.status = 'published'
     WHERE s.tenant_id = p_tenant
       AND ((s.opens_at IS NOT NULL AND s.opens_at - interval '1 hour' > v_from AND s.opens_at - interval '1 hour' <= p_now
             AND p_now < s.opens_at)
            OR (s.closes_at IS NOT NULL AND s.closes_at > v_from + interval '1 hour' AND s.closes_at <= p_now + interval '24 hours')
            OR EXISTS (SELECT 1 FROM lms.assessment_accommodations ac WHERE ac.tenant_id = p_tenant
                         AND ac.assessment_item_id = s.item_id AND ac.extended_close_at > v_from + interval '1 hour'
                         AND ac.extended_close_at <= p_now + interval '24 hours'))),
  per AS MATERIALIZED (
    SELECT w.item_id, w.offering_id, w.opens_at, w.closes_at, w.title, w.course, w.visible_from, p.id AS participant_id,
           p.membership_id, ac.extended_close_at
      FROM qwin w
      CROSS JOIN LATERAL (SELECT pp.id, pp.membership_id FROM lms.course_participants pp
                           WHERE pp.tenant_id = p_tenant AND pp.offering_id = w.offering_id
                             AND pp.participation = 'learner' AND pp.status = 'active' OFFSET 0) p
      LEFT JOIN LATERAL (SELECT a2.extended_close_at FROM lms.assessment_accommodations a2
                          WHERE a2.tenant_id = p_tenant AND a2.assessment_item_id = w.item_id AND a2.participant_id = p.id
                         OFFSET 0) ac ON true),
  opening AS (
    SELECT c.item_id, c.offering_id, c.title, c.course, c.visible_from, c.participant_id, c.membership_id,
           c.opens_at AS at, 'opens' AS what, 1 AS hours, c.opens_at + interval '1 hour' AS expires
      FROM per c
     WHERE c.opens_at IS NOT NULL AND c.opens_at - interval '1 hour' > v_from AND c.opens_at - interval '1 hour' <= p_now
       AND p_now < c.opens_at),
  closing AS (
    SELECT c.item_id, c.offering_id, c.title, c.course, c.visible_from, c.participant_id, c.membership_id,
           c.close_at AS at, 'closes' AS what,
           CASE WHEN c.close_at - interval '1 hour' > v_from AND c.close_at - interval '1 hour' <= p_now AND p_now < c.close_at THEN 1
                WHEN c.close_at - interval '24 hours' > v_from AND c.close_at - interval '24 hours' <= p_now
                     AND p_now < c.close_at - interval '1 hour' THEN 24 END AS hours,
           c.close_at AS expires
      FROM (SELECT p.*, coalesce(p.extended_close_at, p.closes_at) AS close_at FROM per p
             WHERE p.closes_at IS NOT NULL AND coalesce(p.opens_at, '-infinity'::timestamptz) <= p_now) c),
  allq AS (SELECT * FROM opening UNION ALL SELECT * FROM closing WHERE hours IS NOT NULL),
  vis AS (
    SELECT q.* FROM allq q
     WHERE q.visible_from <= greatest(p_now, q.at)
       AND NOT EXISTS (SELECT 1 FROM lms.attempts x WHERE x.tenant_id = p_tenant AND x.assessment_item_id = q.item_id
                         AND x.participant_id = q.participant_id AND x.status IN ('submitted', 'graded')))
  SELECT array_agg(ROW(p_tenant, m.user_id, 'learning_deadlines', 'quiz_' || v.what,
                       jsonb_build_object('course', v.course, 'item', v.title, 'hours', v.hours, 'at', v.at),
                       '/offerings/' || v.offering_id || '/items/' || v.item_id,
                       'quiz' || v.what || v.hours || ':' || v.item_id || ':' || v.participant_id || ':'
                         || floor(extract(epoch FROM v.at))::bigint,
                       'quiz_' || v.what, v.expires, true)::lms.notify_item)
    INTO items
    FROM vis v
    CROSS JOIN LATERAL (SELECT mm.user_id FROM lms.tenant_memberships mm
                         WHERE mm.tenant_id = p_tenant AND mm.id = v.membership_id AND mm.status = 'active' OFFSET 0) m;
  v_n := lms.notify_fanout(items);
  v_out := v_out || jsonb_build_object('quizReminders', coalesce(cardinality(items), 0));

  -- -------------------------------------------------- quiz results that became visible by the clock (after_close)
  SELECT array_agg(ROW(p_tenant, m.user_id, 'learning_grades', 'grade_released',
                       jsonb_build_object('course', lms.notify_offering_title(p_tenant, x.offering_id), 'item', i.title,
                                          'kind', 'assessment', 'hasFeedback', false),
                       '/offerings/' || x.offering_id || '/attempts/' || x.id || '/result',
                       'results:' || x.id, 'grade_released', NULL::timestamptz, true)::lms.notify_item)
    INTO items
    FROM lms.assessments s
    JOIN lms.attempts x ON x.tenant_id = s.tenant_id AND x.assessment_item_id = s.item_id AND x.status = 'graded'
    JOIN lms.content_items i ON i.tenant_id = s.tenant_id AND i.id = s.item_id AND i.deleted_at IS NULL
    JOIN lms.course_participants p ON p.tenant_id = x.tenant_id AND p.id = x.participant_id AND p.status = 'active'
    JOIN lms.tenant_memberships m ON m.tenant_id = p.tenant_id AND m.id = p.membership_id AND m.status = 'active'
    LEFT JOIN lms.assessment_accommodations ac ON ac.tenant_id = s.tenant_id AND ac.assessment_item_id = s.item_id
                                              AND ac.participant_id = x.participant_id
   WHERE s.tenant_id = p_tenant AND s.results_visibility = 'after_close'
     AND (s.closes_at > v_from AND s.closes_at <= p_now OR ac.extended_close_at > v_from AND ac.extended_close_at <= p_now)
     AND coalesce(ac.extended_close_at, s.closes_at) > v_from AND coalesce(ac.extended_close_at, s.closes_at) <= p_now;
  v_n := lms.notify_fanout(items);
  v_out := v_out || jsonb_build_object('results', coalesce(cardinality(items), 0));

  -- -------------------------------------------------- the daily digests (once per local date, from the digest hour)
  IF extract(hour FROM v_local) >= v_digest_hour
     AND NOT EXISTS (SELECT 1 FROM lms.notify_runs r WHERE r.tenant_id = p_tenant AND r.kind = 'daily' AND r.local_date = v_date) THEN
    INSERT INTO lms.notify_runs (tenant_id, kind, local_date) VALUES (p_tenant, 'daily', v_date);

    -- new content, one digest per course per day
    WITH due AS MATERIALIZED (
      DELETE FROM lms.notify_content_marks k WHERE k.tenant_id = p_tenant AND k.visible_at <= p_now
      RETURNING k.item_id, k.offering_id),
    vis AS (
      SELECT d.offering_id, i.title, i.position, md.position AS mpos
        FROM due d
        JOIN lms.content_items i ON i.tenant_id = p_tenant AND i.id = d.item_id AND i.published AND i.deleted_at IS NULL
        JOIN lms.content_modules md ON md.tenant_id = p_tenant AND md.id = i.module_id AND md.published AND md.deleted_at IS NULL
        JOIN lms.course_offerings o ON o.tenant_id = p_tenant AND o.id = d.offering_id AND o.status = 'published'
       WHERE coalesce(greatest(i.available_from, md.available_from), '-infinity'::timestamptz) <= p_now),
    per AS (
      SELECT v.offering_id, count(*)::int AS n,
             (array_agg(v.title ORDER BY v.mpos, v.position))[1:5] AS titles
        FROM vis v GROUP BY v.offering_id)
    SELECT array_agg(ROW(p_tenant, m.user_id, 'learning_content', 'content_digest',
                         jsonb_build_object('course', lms.notify_offering_title(p_tenant, per.offering_id), 'count', per.n,
                                            'titles', to_jsonb(per.titles)),
                         '/offerings/' || per.offering_id, 'content:' || per.offering_id || ':' || v_date,
                         'content_digest', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM per
      JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.offering_id = per.offering_id
                                    AND p.participation = 'learner' AND p.status = 'active'
      JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.id = p.membership_id AND m.status = 'active';
    v_n := lms.notify_fanout(items);
    v_out := v_out || jsonb_build_object('contentDigests', coalesce(cardinality(items), 0));

    -- work waiting to be graded: one digest per instructor / assistant (counts per course)
    WITH offs AS MATERIALIZED (
      SELECT o.id FROM lms.course_offerings o WHERE o.tenant_id = p_tenant AND o.status = 'published'),
    latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.offering_id, s.assignment_item_id, s.participant_id
        FROM lms.submissions s
       WHERE s.tenant_id = p_tenant AND s.offering_id IN (SELECT id FROM offs)
       ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
    waiting AS (
      SELECT l.offering_id FROM latest l
       WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g WHERE g.tenant_id = p_tenant
                           AND g.assignment_item_id = l.assignment_item_id AND g.participant_id = l.participant_id
                           AND g.submission_id = l.id)
      UNION ALL
      SELECT x.offering_id FROM lms.attempts x
       WHERE x.tenant_id = p_tenant AND x.status = 'submitted' AND x.offering_id IN (SELECT id FROM offs)),
    per AS (SELECT w.offering_id, count(*)::int AS n FROM waiting w GROUP BY w.offering_id),
    staff AS (
      SELECT m.user_id, per.offering_id, per.n
        FROM per
        JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.offering_id = per.offering_id
                                      AND p.participation IN ('instructor', 'assistant') AND p.status = 'active'
        JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.id = p.membership_id AND m.status = 'active'),
    agg AS (
      SELECT s.user_id, sum(s.n)::int AS total,
             (jsonb_agg(jsonb_build_object('course', lms.notify_offering_title(p_tenant, s.offering_id), 'count', s.n)
                        ORDER BY s.n DESC))
        AS courses
        FROM staff s GROUP BY s.user_id)
    SELECT array_agg(ROW(p_tenant, a.user_id, 'teaching_grading', 'grading_digest',
                         jsonb_build_object('total', a.total,
                                            'courses', (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(a.courses) e LIMIT 10) z)),
                         '/teaching', 'grading:' || v_date, 'grading_digest', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM agg a WHERE a.total > 0;
    v_n := lms.notify_fanout(items);
    v_out := v_out || jsonb_build_object('gradingDigests', coalesce(cardinality(items), 0));
  END IF;

  -- -------------------------------------------------- the weekly summaries (Mondays, from the digest hour)
  IF extract(isodow FROM v_local) = 1 AND extract(hour FROM v_local) >= v_digest_hour
     AND NOT EXISTS (SELECT 1 FROM lms.notify_runs r WHERE r.tenant_id = p_tenant AND r.kind = 'weekly' AND r.local_date = v_date) THEN
    INSERT INTO lms.notify_runs (tenant_id, kind, local_date) VALUES (p_tenant, 'weekly', v_date);

    -- at-risk: COUNTS per course and a link, to the course's instructors and assistants (no names, no evidence)
    WITH f AS MATERIALIZED (
      SELECT x.offering_id, count(*)::int AS n FROM lms.atrisk_flags(p_tenant, p_now) x
       WHERE x.f_behind OR x.f_missed OR x.f_low OR x.f_inactive GROUP BY x.offering_id),
    staff AS (
      SELECT m.user_id, f.offering_id, f.n
        FROM f
        JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.offering_id = f.offering_id
                                      AND p.participation IN ('instructor', 'assistant') AND p.status = 'active'
        JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.id = p.membership_id AND m.status = 'active'),
    agg AS (
      SELECT s.user_id, sum(s.n)::int AS total,
             jsonb_agg(jsonb_build_object('course', lms.notify_offering_title(p_tenant, s.offering_id), 'count', s.n)
                       ORDER BY s.n DESC) AS courses
        FROM staff s GROUP BY s.user_id)
    SELECT array_agg(ROW(p_tenant, a.user_id, 'teaching_updates', 'atrisk_weekly',
                         jsonb_build_object('total', a.total,
                                            'courses', (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(a.courses) e LIMIT 10) z)),
                         '/teaching', 'atrisk:' || v_date, 'atrisk_weekly', NULL::timestamptz, true)::lms.notify_item)
      INTO items
      FROM agg a WHERE a.total > 0;
    v_n := lms.notify_fanout(items);
    v_out := v_out || jsonb_build_object('atRiskSummaries', coalesce(cardinality(items), 0));

    -- course health: the NUMBER of running courses that need attention (the same rule as the report), to the admins
    SELECT coalesce((s.value ->> 'showCourseHealth')::boolean, true), coalesce((s.value ->> 'courseHealthWeeks')::int, 3),
           coalesce((s.value ->> 'courseHealthBacklogDays')::int, 14)
      INTO v_health, v_weeks, v_backlog
      FROM (SELECT (SELECT value FROM lms.tenant_settings WHERE tenant_id = p_tenant AND key = 'analytics') AS value) s;
    IF coalesce(v_health, true) THEN
      WITH offs AS MATERIALIZED (
        SELECT o.id FROM lms.course_offerings o
          JOIN lms.terms tm ON tm.tenant_id = o.tenant_id AND tm.id = o.term_id
         WHERE o.tenant_id = p_tenant AND o.status = 'published'
           AND tm.end_date >= v_date AND tm.start_date <= v_date),
      ci AS (SELECT i.offering_id, max(greatest(i.created_at, i.updated_at)) AS last_content
               FROM lms.content_items i WHERE i.tenant_id = p_tenant AND i.deleted_at IS NULL
                AND i.offering_id IN (SELECT id FROM offs) GROUP BY i.offering_id),
      latest AS MATERIALIZED (
        SELECT DISTINCT ON (s.assignment_item_id, s.participant_id) s.id, s.offering_id, s.assignment_item_id, s.participant_id,
               s.submitted_at
          FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.offering_id IN (SELECT id FROM offs)
         ORDER BY s.assignment_item_id, s.participant_id, s.version_no DESC),
      waiting AS (
        SELECT l.offering_id, l.submitted_at AS since FROM latest l
         WHERE NOT EXISTS (SELECT 1 FROM lms.assignment_grades g WHERE g.tenant_id = p_tenant
                             AND g.assignment_item_id = l.assignment_item_id AND g.participant_id = l.participant_id
                             AND g.submission_id = l.id)
        UNION ALL
        SELECT x.offering_id, x.submitted_at FROM lms.attempts x
         WHERE x.tenant_id = p_tenant AND x.status = 'submitted' AND x.offering_id IN (SELECT id FROM offs)),
      wt AS (SELECT w.offering_id, min(w.since) AS oldest FROM waiting w GROUP BY w.offering_id),
      bad AS (
        SELECT o.id FROM offs o LEFT JOIN ci ON ci.offering_id = o.id LEFT JOIN wt ON wt.offering_id = o.id
         WHERE ci.last_content IS NULL OR ci.last_content < p_now - make_interval(weeks => v_weeks)
            OR (wt.oldest IS NOT NULL AND wt.oldest < p_now - make_interval(days => v_backlog)))
      SELECT array_agg(ROW(p_tenant, m.user_id, 'admin', 'course_health_weekly',
                           jsonb_build_object('count', (SELECT count(*) FROM bad)),
                           '/college-dashboard', 'health:' || v_date, 'course_health_weekly', NULL::timestamptz,
                           true)::lms.notify_item)
        INTO items
        FROM lms.tenant_memberships m
       WHERE m.tenant_id = p_tenant AND m.role = 'institution_admin' AND m.status = 'active'
         AND (SELECT count(*) FROM bad) > 0;
      v_n := lms.notify_fanout(items);
      v_out := v_out || jsonb_build_object('courseHealthSummaries', coalesce(cardinality(items), 0));
    END IF;
  END IF;

  INSERT INTO lms.notify_scan_state (tenant_id, scanned_until) VALUES (p_tenant, p_now)
  ON CONFLICT (tenant_id) DO UPDATE SET scanned_until = EXCLUDED.scanned_until;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_scan_tenant(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_scan_tenant(uuid, timestamptz) TO lms_app;

-- the colleges the scan visits (active ones)
CREATE FUNCTION lms.notify_scan_tenants()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$ SELECT t.id FROM lms.tenants t WHERE t.status = 'active' ORDER BY t.id $$;
REVOKE ALL ON FUNCTION lms.notify_scan_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_scan_tenants() TO lms_app;

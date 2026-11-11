-- Step 9b: assessments (quizzes and exams) and the server-authoritative attempt engine.
--
-- An assessment is a content item of kind 'assessment' (settings in `assessments`, its questions in
-- `assessment_slots`). An ATTEMPT freezes everything it showed: the question VERSIONS, their order, the option order
-- of each question, and the server deadline. Answers live on the question row of the attempt, so an autosave is one
-- UPDATE by primary key. Learners never write or read these tables directly: every learner call is a hardened
-- SECURITY DEFINER function (assessment_start / attempt_read / attempt_save / attempt_submit / assessment_me /
-- attempt_result) on an autocommit connection (2 round trips with the session lookup).

-- ------------------------------------------------------------------ the new item kind
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lms.content_items'::regclass AND contype = 'c'
              AND conname NOT IN ('content_items_kind_ck', 'content_items_completion_ck')
              AND pg_get_constraintdef(oid) LIKE '%ARRAY[%video%'
  LOOP
    EXECUTE format('ALTER TABLE lms.content_items DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'lms.item_progress'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%threshold%' AND pg_get_constraintdef(oid) NOT LIKE '%completed_at%'
  LOOP
    EXECUTE format('ALTER TABLE lms.item_progress DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('text', 'file', 'link', 'video', 'assessment'));
ALTER TABLE lms.content_items DROP CONSTRAINT content_items_kind_ck;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_kind_ck CHECK (
  CASE kind
    WHEN 'text' THEN body IS NOT NULL AND file_id IS NULL AND url IS NULL AND video_asset_id IS NULL
    WHEN 'file' THEN file_id IS NOT NULL AND body IS NULL AND url IS NULL AND video_asset_id IS NULL
    WHEN 'link' THEN url IS NOT NULL AND body IS NULL AND file_id IS NULL AND video_asset_id IS NULL
    WHEN 'video' THEN video_asset_id IS NOT NULL AND body IS NULL AND file_id IS NULL AND url IS NULL
    ELSE body IS NULL AND file_id IS NULL AND url IS NULL AND video_asset_id IS NULL
  END);
ALTER TABLE lms.content_items DROP CONSTRAINT content_items_completion_ck;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_completion_ck CHECK (
  completion IN ('manual', 'on_view', 'watch', 'on_submit')
  AND ((kind = 'video') = (completion = 'watch'))
  AND ((kind = 'assessment') = (completion = 'on_submit')));
ALTER TABLE lms.item_progress ADD CONSTRAINT item_progress_completed_how_check
  CHECK (completed_how IN ('threshold', 'manual', 'view', 'submit'));

CREATE OR REPLACE FUNCTION lms.content_item_completion_default()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  NEW.completion := CASE NEW.kind WHEN 'text' THEN 'manual' WHEN 'video' THEN 'watch'
                                  WHEN 'assessment' THEN 'on_submit' ELSE 'on_view' END;
  RETURN NEW;
END
$$;

-- ------------------------------------------------------------------ settings
CREATE TABLE lms.assessments (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  course_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'practice' CHECK (kind IN ('practice', 'exam')),
  opens_at timestamptz,
  closes_at timestamptz,
  -- NULL = no limit of its own: the attempt still ends at the close date, or after 24 hours (nothing stays open forever)
  time_limit_minutes integer CHECK (time_limit_minutes BETWEEN 1 AND 720),
  attempts_allowed integer NOT NULL DEFAULT 1 CHECK (attempts_allowed BETWEEN 1 AND 20),
  scoring text NOT NULL DEFAULT 'highest' CHECK (scoring IN ('highest', 'latest', 'average')),
  shuffle_questions boolean NOT NULL DEFAULT false,
  shuffle_options boolean NOT NULL DEFAULT false,
  -- percent of the maximum
  passing_score numeric(5, 2) CHECK (passing_score BETWEEN 0 AND 100),
  results_visibility text NOT NULL DEFAULT 'immediate' CHECK (results_visibility IN ('immediate', 'after_close', 'manual')),
  answers_visibility text NOT NULL DEFAULT 'never' CHECK (answers_visibility IN ('never', 'after_close', 'after_release')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  CONSTRAINT assessments_window_ck CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at),
  CONSTRAINT assessments_after_close_ck CHECK (
    closes_at IS NOT NULL OR (results_visibility <> 'after_close' AND answers_visibility <> 'after_close')),
  CONSTRAINT assessments_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.content_items (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT assessments_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assessments_offering_idx ON lms.assessments (tenant_id, offering_id);

-- every assessment item gets its settings row at once (defaults), also when content is copied
CREATE FUNCTION lms.assessment_default_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  INSERT INTO lms.assessments (tenant_id, item_id, offering_id, course_id)
  SELECT NEW.tenant_id, NEW.id, NEW.offering_id, o.course_id
    FROM lms.course_offerings o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.offering_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.assessment_default_row() FROM PUBLIC;
CREATE TRIGGER content_items_assessment_row AFTER INSERT ON lms.content_items
  FOR EACH ROW WHEN (NEW.kind = 'assessment') EXECUTE FUNCTION lms.assessment_default_row();

-- the questions of an assessment: a fixed question, or N random ones from the bank by tag and / or difficulty
CREATE TABLE lms.assessment_slots (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assessment_item_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position >= 1),
  kind text NOT NULL CHECK (kind IN ('fixed', 'pool')),
  question_id uuid,
  tag text CHECK (length(tag) BETWEEN 1 AND 40),
  difficulty text CHECK (difficulty IN ('easy', 'medium', 'hard')),
  count smallint NOT NULL DEFAULT 1 CHECK (count BETWEEN 1 AND 100),
  points numeric(6, 2) NOT NULL DEFAULT 1 CHECK (points > 0 AND points <= 1000),
  PRIMARY KEY (tenant_id, assessment_item_id, position),
  CONSTRAINT assessment_slots_kind_ck CHECK (
    (kind = 'fixed' AND question_id IS NOT NULL AND tag IS NULL AND difficulty IS NULL AND count = 1)
    OR (kind = 'pool' AND question_id IS NULL)),
  CONSTRAINT assessment_slots_assessment_fk FOREIGN KEY (tenant_id, assessment_item_id)
    REFERENCES lms.assessments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT assessment_slots_question_fk FOREIGN KEY (tenant_id, question_id)
    REFERENCES lms.questions (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assessment_slots_question_idx ON lms.assessment_slots (tenant_id, question_id) WHERE question_id IS NOT NULL;

-- per-learner accommodations. SENSITIVE: `reason` can reveal a disability or a health condition. It is read only by
-- the accommodation endpoints (instructors and administrators), never joined into a class list or an export, and never
-- written to the audit log.
CREATE TABLE lms.assessment_accommodations (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assessment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  extra_minutes integer NOT NULL DEFAULT 0 CHECK (extra_minutes BETWEEN 0 AND 720),
  extended_close_at timestamptz,
  reason text CHECK (length(reason) <= 300),
  set_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assessment_item_id, participant_id),
  CONSTRAINT accommodations_assessment_fk FOREIGN KEY (tenant_id, assessment_item_id)
    REFERENCES lms.assessments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT accommodations_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------ attempts (history: never deleted, nothing cascades into them)
CREATE TABLE lms.attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assessment_item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  attempt_no smallint NOT NULL CHECK (attempt_no >= 1),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'graded')),
  started_at timestamptz NOT NULL DEFAULT now(),
  -- the SERVER decides: min(start + time limit + accommodation, close time); the client only displays it
  deadline_at timestamptz NOT NULL,
  submitted_at timestamptz,
  submit_kind text CHECK (submit_kind IN ('manual', 'deadline')),
  score numeric(8, 2),
  max_score numeric(8, 2),
  -- answers a person still has to grade; 'graded' = status when this is 0
  pending_manual integer NOT NULL DEFAULT 0 CHECK (pending_manual >= 0),
  graded_at timestamptz,
  released_at timestamptz,
  feedback text CHECK (length(feedback) <= 5000),
  event_count smallint NOT NULL DEFAULT 0,
  CONSTRAINT attempts_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT attempts_number_key UNIQUE (tenant_id, assessment_item_id, participant_id, attempt_no),
  CONSTRAINT attempts_done_ck CHECK ((status = 'in_progress') = (submitted_at IS NULL)),
  CONSTRAINT attempts_assessment_fk FOREIGN KEY (tenant_id, assessment_item_id)
    REFERENCES lms.assessments (tenant_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT attempts_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
-- one active attempt per learner per assessment: the database says so, two tabs cannot both start one
CREATE UNIQUE INDEX attempts_one_active ON lms.attempts (tenant_id, assessment_item_id, participant_id)
  WHERE status = 'in_progress';
-- the auto-submit sweeper (all tenants): the oldest due deadline first
CREATE INDEX attempts_deadline_idx ON lms.attempts (deadline_at) WHERE status = 'in_progress';
CREATE INDEX attempts_assessment_idx ON lms.attempts (tenant_id, assessment_item_id, id);
CREATE INDEX attempts_offering_idx ON lms.attempts (tenant_id, offering_id, assessment_item_id);

CREATE TABLE lms.attempt_questions (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  attempt_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position >= 1),
  assessment_item_id uuid NOT NULL,
  question_id uuid NOT NULL,
  -- exactly the version this attempt showed (editing the question later changes nothing here)
  question_version_id uuid NOT NULL,
  -- the version whose key scores this row: the shown one, or a corrected one after a regrade
  scored_version_id uuid NOT NULL,
  points numeric(6, 2) NOT NULL CHECK (points > 0),
  -- option ids in the order shown (random ids; the order is frozen at start)
  option_order text[] NOT NULL DEFAULT '{}',
  answer jsonb CHECK (octet_length(answer::text) <= 60000),
  -- the revision of the answer, counted by clients and continued from the server's value after a resume; the highest
  -- (rev, client_at) wins, so an older edit never overwrites a newer one
  rev integer NOT NULL DEFAULT 0 CHECK (rev >= 0),
  client_at bigint NOT NULL DEFAULT 0,
  flagged boolean NOT NULL DEFAULT false,
  answered_at timestamptz,
  spent_ms integer NOT NULL DEFAULT 0 CHECK (spent_ms >= 0),
  score numeric(6, 2),
  manual_state text NOT NULL DEFAULT 'na' CHECK (manual_state IN ('na', 'pending', 'graded')),
  feedback text CHECK (length(feedback) <= 5000),
  graded_by uuid,
  graded_at timestamptz,
  -- a question dropped by a regrade counts neither in the score nor in the maximum
  dropped boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, attempt_id, position),
  CONSTRAINT attempt_questions_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES lms.attempts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempt_questions_shown_fk FOREIGN KEY (tenant_id, question_version_id)
    REFERENCES lms.question_versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempt_questions_scored_fk FOREIGN KEY (tenant_id, scored_version_id)
    REFERENCES lms.question_versions (tenant_id, id) ON DELETE RESTRICT
) WITH (fillfactor = 70);
-- the grading queue (by question) and the item analysis / regrade (by assessment and question)
CREATE INDEX attempt_questions_manual_idx ON lms.attempt_questions (tenant_id, assessment_item_id, question_id, attempt_id)
  WHERE manual_state = 'pending';
CREATE INDEX attempt_questions_question_idx ON lms.attempt_questions (tenant_id, assessment_item_id, question_id);
CREATE INDEX attempt_questions_version_idx ON lms.attempt_questions (tenant_id, question_version_id);

-- informational only (NOT proctoring): what the browser said about the page
CREATE TABLE lms.attempt_events (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  attempt_id uuid NOT NULL,
  n smallint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('hidden', 'visible', 'blur', 'focus', 'offline', 'online', 'resume')),
  PRIMARY KEY (tenant_id, attempt_id, n),
  CONSTRAINT attempt_events_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES lms.attempts (tenant_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------ regrade history
CREATE TABLE lms.regrade_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assessment_item_id uuid NOT NULL,
  question_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('rekey', 'drop', 'credit')),
  from_version_id uuid,
  to_version_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  affected_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT regrade_runs_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT regrade_runs_assessment_fk FOREIGN KEY (tenant_id, assessment_item_id)
    REFERENCES lms.assessments (tenant_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT regrade_runs_question_fk FOREIGN KEY (tenant_id, question_id)
    REFERENCES lms.questions (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX regrade_runs_assessment_idx ON lms.regrade_runs (tenant_id, assessment_item_id, created_at DESC);
CREATE TABLE lms.regrade_changes (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  before_score numeric(8, 2),
  after_score numeric(8, 2),
  before_max numeric(8, 2),
  after_max numeric(8, 2),
  PRIMARY KEY (tenant_id, run_id, attempt_id),
  CONSTRAINT regrade_changes_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES lms.regrade_runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT regrade_changes_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES lms.attempts (tenant_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------ RLS, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assessments', 'assessment_slots', 'assessment_accommodations', 'attempts',
                           'attempt_questions', 'attempt_events', 'regrade_runs', 'regrade_changes']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON lms.%I FOR ALL TO lms_app USING (tenant_id = (SELECT lms.current_tenant_id())) WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))',
      t || '_all', t);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;
GRANT SELECT ON lms.assessments TO lms_app;
GRANT UPDATE (kind, opens_at, closes_at, time_limit_minutes, attempts_allowed, scoring, shuffle_questions,
              shuffle_options, passing_score, results_visibility, answers_visibility, updated_at)
  ON lms.assessments TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.assessment_slots TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.assessment_accommodations TO lms_app;
GRANT UPDATE (extra_minutes, extended_close_at, reason, set_by, updated_at) ON lms.assessment_accommodations TO lms_app;
-- the application READS attempts; learners write only through the definer functions below, instructors grade through
-- these column grants (never `answer`, `rev`, the question set or the deadline)
GRANT SELECT ON lms.attempts, lms.attempt_questions, lms.attempt_events TO lms_app;
GRANT UPDATE (status, score, max_score, pending_manual, graded_at, released_at, feedback) ON lms.attempts TO lms_app;
GRANT UPDATE (score, manual_state, feedback, graded_by, graded_at, scored_version_id, dropped)
  ON lms.attempt_questions TO lms_app;
GRANT SELECT, INSERT ON lms.regrade_runs, lms.regrade_changes TO lms_app;

-- ------------------------------------------------------------------ helpers
-- the close date everybody has had: the assessment's, or the latest extended close of an accommodation
CREATE FUNCTION lms.assessment_effective_close(p_tenant uuid, p_item uuid)
RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT greatest(a.closes_at, (SELECT max(x.extended_close_at) FROM lms.assessment_accommodations x
                                 WHERE x.tenant_id = a.tenant_id AND x.assessment_item_id = a.item_id))
    FROM lms.assessments a WHERE a.tenant_id = p_tenant AND a.item_id = p_item
$$;

-- one place for "may the learner see this yet" (used for the score and for the correct answers)
CREATE FUNCTION lms.results_visible(p_mode text, p_close timestamptz, p_released timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT CASE p_mode
           WHEN 'immediate' THEN true
           WHEN 'after_close' THEN p_close IS NOT NULL AND now() >= p_close
           WHEN 'manual' THEN p_released IS NOT NULL
           WHEN 'after_release' THEN p_released IS NOT NULL
           ELSE false END
$$;

-- ------------------------------------------------------------------ the draw (shared by start and the instructor preview)
-- Fixed questions plus random picks from the pool of the course, never the same question twice. A pool slot is
-- (tag, difficulty, count): several slots give every learner the same MIX with different questions. Raises LMS01 when
-- a pool has fewer candidates than asked.
CREATE FUNCTION lms.assessment_draw(p_tenant uuid, p_item uuid)
RETURNS TABLE (pos integer, question_id uuid, version_id uuid, points numeric, option_order text[])
LANGUAGE plpgsql VOLATILE SET search_path = lms, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  s lms.assessments;
  slot record;
  r record;
  qids uuid[] := '{}';
  vids uuid[] := '{}';
  pts numeric[] := '{}';
  got integer;
BEGIN
  SELECT * INTO s FROM lms.assessments WHERE tenant_id = p_tenant AND item_id = p_item;
  FOR slot IN SELECT * FROM lms.assessment_slots WHERE tenant_id = p_tenant AND assessment_item_id = p_item ORDER BY position LOOP
    IF slot.kind = 'fixed' THEN
      IF slot.question_id = ANY (qids) THEN CONTINUE; END IF;
      qids := qids || slot.question_id;
      vids := vids || (SELECT q.current_version_id FROM lms.questions q WHERE q.tenant_id = p_tenant AND q.id = slot.question_id);
      pts := pts || slot.points;
    ELSE
      got := 0;
      FOR r IN
        SELECT q.id, q.current_version_id
          FROM lms.questions q
          JOIN lms.question_versions v ON v.tenant_id = q.tenant_id AND v.id = q.current_version_id
         WHERE q.tenant_id = p_tenant AND q.course_id = s.course_id AND q.status = 'active'
           AND (slot.difficulty IS NULL OR v.difficulty = slot.difficulty)
           AND (slot.tag IS NULL OR EXISTS (SELECT 1 FROM lms.question_tags t
                 WHERE t.tenant_id = q.tenant_id AND t.question_id = q.id AND t.tag = slot.tag))
           AND NOT (q.id = ANY (qids))
         ORDER BY random() LIMIT slot.count
      LOOP
        qids := qids || r.id; vids := vids || r.current_version_id; pts := pts || slot.points; got := got + 1;
      END LOOP;
      IF got < slot.count THEN
        RAISE EXCEPTION 'pool of slot % has too few questions', slot.position USING ERRCODE = 'LMS01';
      END IF;
    END IF;
  END LOOP;
  RETURN QUERY
    SELECT (row_number() OVER (ORDER BY CASE WHEN s.shuffle_questions THEN random() END, d.ord))::integer,
           d.qid, d.vid, d.pt,
           coalesce((SELECT array_agg(o.o ->> 'id' ORDER BY CASE WHEN s.shuffle_options THEN random() END, o.ord)
                       FROM lms.question_versions v,
                            LATERAL jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) WITH ORDINALITY o(o, ord)
                      WHERE v.tenant_id = p_tenant AND v.id = d.vid), '{}'::text[])
      FROM unnest(qids, vids, pts) WITH ORDINALITY d(qid, vid, pt, ord);
END
$$;
REVOKE ALL ON FUNCTION lms.assessment_draw(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_draw(uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ finalising attempts (internal: no grant)
-- Scores a set of in-progress attempts in ONE statement (set based; a single submit passes one id, the sweeper up to a
-- few hundred): objective questions are scored, essays and manual short answers wait in the grading queue, the attempt
-- becomes 'graded' (nothing pending) or 'submitted', and the item counts as done for the learner's progress.
CREATE FUNCTION lms.attempts_finalize(p_tenants uuid[], p_attempts uuid[], p_kind text)
RETURNS integer
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH todo AS MATERIALIZED (
    SELECT a.tenant_id, a.id
      FROM lms.attempts a
      JOIN unnest(p_tenants, p_attempts) x(t, i) ON a.tenant_id = x.t AND a.id = x.i
     WHERE a.status = 'in_progress'
       FOR UPDATE OF a),
  calc AS MATERIALIZED (
    SELECT aq.tenant_id, aq.attempt_id, aq.position, r.score, r.manual
      FROM todo t
      JOIN lms.attempt_questions aq ON aq.tenant_id = t.tenant_id AND aq.attempt_id = t.id
      JOIN LATERAL (SELECT v.type, v.answer_key FROM lms.question_versions v
                     WHERE v.tenant_id = aq.tenant_id AND v.id = aq.scored_version_id OFFSET 0) v ON true
      CROSS JOIN LATERAL lms.score_answer(v.type, v.answer_key, aq.answer, aq.points) r),
  upd AS (
    UPDATE lms.attempt_questions aq
       SET score = c.score, manual_state = CASE WHEN c.manual THEN 'pending' ELSE 'na' END
      FROM calc c
     WHERE aq.tenant_id = c.tenant_id AND aq.attempt_id = c.attempt_id AND aq.position = c.position
    RETURNING aq.tenant_id, aq.attempt_id, aq.score, aq.points, aq.manual_state, aq.dropped),
  tot AS (
    SELECT tenant_id, attempt_id,
           coalesce(sum(score) FILTER (WHERE NOT dropped), 0) AS score,
           coalesce(sum(points) FILTER (WHERE NOT dropped), 0) AS max_score,
           count(*) FILTER (WHERE manual_state = 'pending')::integer AS pending
      FROM upd GROUP BY tenant_id, attempt_id),
  att AS (
    UPDATE lms.attempts a
       SET status = CASE WHEN tot.pending = 0 THEN 'graded' ELSE 'submitted' END,
           submitted_at = now(), submit_kind = p_kind,
           score = tot.score, max_score = tot.max_score, pending_manual = tot.pending,
           graded_at = CASE WHEN tot.pending = 0 THEN now() END
      FROM tot
     WHERE a.tenant_id = tot.tenant_id AND a.id = tot.attempt_id
    RETURNING a.tenant_id, a.participant_id, a.assessment_item_id, a.offering_id),
  prog AS (
    INSERT INTO lms.item_progress AS ip (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how)
    SELECT tenant_id, participant_id, assessment_item_id, offering_id, 'completed', now(), 'submit' FROM att
    ON CONFLICT (tenant_id, participant_id, item_id) DO UPDATE SET
      status = 'completed',
      completed_at = coalesce(ip.completed_at, now()),
      completed_how = coalesce(ip.completed_how, 'submit'),
      last_activity_at = now())
  SELECT count(*)::integer INTO n FROM att;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.attempts_finalize(uuid[], uuid[], text) FROM PUBLIC;

-- ------------------------------------------------------------------ start (one call)
-- result: ok | no_offering | forbidden | not_visible (the item gate of progress) | not_open | closed |
-- no_attempts_left | empty | pool_too_small. `resumed`: the learner already had an active attempt (this is also how a
-- reload or another device finds it).
CREATE FUNCTION lms.assessment_start(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_grace integer)
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
  IF used >= s.attempts_allowed THEN RETURN jsonb_build_object('result', 'no_attempts_left'); END IF;
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

-- ------------------------------------------------------------------ read the attempt (resume after a reload / on another device)
-- Sends ONLY what a learner may see: stem, images, options (id + text, in the frozen order), saved answers and each
-- question's current server rev. Never `answer_key`: it is not in this function's output by construction.
CREATE FUNCTION lms.attempt_read(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid, p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
  s lms.assessments;
  title text;
BEGIN
  SELECT a.* INTO att FROM lms.attempts a
   WHERE a.tenant_id = p_tenant AND a.id = p_attempt AND a.offering_id = p_offering
     AND EXISTS (SELECT 1 FROM lms.course_participants cp
                   JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  WHERE cp.tenant_id = a.tenant_id AND cp.id = a.participant_id AND cp.status = 'active'
                    AND tm.user_id = p_user AND tm.status = 'active');
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF att.status = 'in_progress' AND now() > att.deadline_at + make_interval(secs => p_grace) THEN
    PERFORM lms.attempts_finalize(ARRAY[p_tenant], ARRAY[att.id], 'deadline');
    SELECT * INTO att FROM lms.attempts WHERE tenant_id = p_tenant AND id = p_attempt;
  END IF;
  SELECT * INTO s FROM lms.assessments WHERE tenant_id = p_tenant AND item_id = att.assessment_item_id;
  SELECT i.title INTO title FROM lms.content_items i WHERE i.tenant_id = p_tenant AND i.id = att.assessment_item_id;
  RETURN jsonb_build_object(
    'result', 'ok',
    'attempt', jsonb_build_object(
      'id', att.id, 'itemId', att.assessment_item_id, 'title', title, 'kind', s.kind, 'attemptNo', att.attempt_no,
      'status', att.status, 'startedAt', att.started_at, 'deadlineAt', att.deadline_at, 'serverNow', now(),
      'submittedAt', att.submitted_at),
    'questions', CASE WHEN att.status <> 'in_progress' THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'position', aq.position, 'type', v.type, 'points', aq.points,
               'stem', v.presentation -> 'stem',
               'images', coalesce(v.presentation -> 'images', '[]'::jsonb),
               'maxWords', v.presentation -> 'maxWords',
               'options', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o -> 'text')
                                                     ORDER BY array_position(aq.option_order, o ->> 'id'))
                                      FROM jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) o), '[]'::jsonb),
               'answer', aq.answer, 'rev', aq.rev, 'flagged', aq.flagged) ORDER BY aq.position)
        FROM lms.attempt_questions aq
        JOIN LATERAL (SELECT vv.type, vv.presentation FROM lms.question_versions vv
                       WHERE vv.tenant_id = aq.tenant_id AND vv.id = aq.question_version_id OFFSET 0) v ON true
       WHERE aq.tenant_id = p_tenant AND aq.attempt_id = p_attempt), '[]'::jsonb) END);
END
$$;
REVOKE ALL ON FUNCTION lms.attempt_read(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_read(uuid, uuid, uuid, uuid, integer) TO lms_app;

-- ------------------------------------------------------------------ autosave (one call; batch = the offline queue)
-- p_answers: [{ "p": position, "a": {answer} | null, "rev": n, "f": flagged, "at": clientEpochMs, "ms": spentMs }].
-- A change is applied only when its (rev, at) is HIGHER than the stored one, so a retry, an older tab or a stale device
-- never overwrites a newer edit; every answer that was NOT applied comes back in `stale` with the server's value so the
-- client adopts it. Rejected after deadline + grace (the attempt is then closed here and now).
-- p_events: [{ "k": kind, "t": clientEpochMs }] appended to the integrity log (at most 300 per attempt).
CREATE FUNCTION lms.attempt_save(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid,
                                 p_answers jsonb, p_events jsonb, p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
  res jsonb;
  n_events integer;
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
  IF now() > att.deadline_at + make_interval(secs => p_grace) THEN
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
REVOKE ALL ON FUNCTION lms.attempt_save(uuid, uuid, uuid, uuid, jsonb, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_save(uuid, uuid, uuid, uuid, jsonb, jsonb, integer) TO lms_app;

-- ------------------------------------------------------------------ submit (idempotent)
CREATE FUNCTION lms.attempt_submit(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
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
    PERFORM lms.attempts_finalize(ARRAY[p_tenant], ARRAY[p_attempt], 'manual');
    SELECT * INTO att FROM lms.attempts WHERE tenant_id = p_tenant AND id = p_attempt;
  END IF;
  -- the second click / the other tab arrives here and gets the same answer
  RETURN jsonb_build_object('result', 'ok', 'status', att.status, 'submittedAt', att.submitted_at);
END
$$;
REVOKE ALL ON FUNCTION lms.attempt_submit(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_submit(uuid, uuid, uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ auto-submit (worker, all tenants)
-- Closes attempts whose deadline + grace has passed, oldest first, a batch per call. Concurrent workers take
-- different rows (SKIP LOCKED), so an attempt is finalised exactly once.
CREATE FUNCTION lms.assessment_sweep(p_limit integer, p_grace integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  ts uuid[];
  ids uuid[];
BEGIN
  SELECT array_agg(d.tenant_id), array_agg(d.id) INTO ts, ids
    FROM (SELECT a.tenant_id, a.id FROM lms.attempts a
           WHERE a.status = 'in_progress' AND a.deadline_at + make_interval(secs => p_grace) < now()
           ORDER BY a.deadline_at
           LIMIT least(greatest(p_limit, 1), 1000)
             FOR UPDATE OF a SKIP LOCKED) d;
  IF ts IS NULL THEN RETURN 0; END IF;
  RETURN lms.attempts_finalize(ts, ids, 'deadline');
END
$$;
REVOKE ALL ON FUNCTION lms.assessment_sweep(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_sweep(integer, integer) TO lms_app;

-- ------------------------------------------------------------------ the learner's page of an assessment
CREATE FUNCTION lms.assessment_me(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  s lms.assessments;
  acc lms.assessment_accommodations;
  title text;
  eff_close timestamptz;
  my_close timestamptz;
  used integer;
  blocked text;
  has_active boolean;
  questions integer;
  counted jsonb;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assessment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  -- attempts past their deadline are closed now, so the page never offers one that is over
  PERFORM lms.attempts_finalize(ARRAY_AGG(a.tenant_id), ARRAY_AGG(a.id), 'deadline')
     FROM lms.attempts a
    WHERE a.tenant_id = p_tenant AND a.assessment_item_id = p_item AND a.participant_id = g.participant_id
      AND a.status = 'in_progress' AND now() > a.deadline_at + make_interval(secs => p_grace)
   HAVING count(*) > 0;
  SELECT * INTO s FROM lms.assessments WHERE tenant_id = p_tenant AND item_id = p_item;
  SELECT i.title INTO title FROM lms.content_items i WHERE i.tenant_id = p_tenant AND i.id = p_item;
  SELECT * INTO acc FROM lms.assessment_accommodations
   WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id;
  eff_close := lms.assessment_effective_close(p_tenant, p_item);
  my_close := CASE WHEN s.closes_at IS NULL THEN NULL ELSE greatest(s.closes_at, coalesce(acc.extended_close_at, s.closes_at)) END;
  SELECT count(*), coalesce(bool_or(status = 'in_progress'), false) INTO used, has_active
    FROM lms.attempts WHERE tenant_id = p_tenant AND assessment_item_id = p_item AND participant_id = g.participant_id;
  SELECT coalesce(sum(CASE WHEN kind = 'pool' THEN count ELSE 1 END), 0) INTO questions
    FROM lms.assessment_slots WHERE tenant_id = p_tenant AND assessment_item_id = p_item;
  blocked := CASE
    WHEN has_active THEN NULL
    WHEN questions = 0 THEN 'empty'
    WHEN s.opens_at IS NOT NULL AND now() < s.opens_at THEN 'not_open'
    WHEN my_close IS NOT NULL AND now() >= my_close THEN 'closed'
    WHEN used >= s.attempts_allowed THEN 'no_attempts_left' END;

  -- the score that counts (policy of the assessment) among graded attempts whose results the learner may see
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
           'score', CASE s.scoring WHEN 'highest' THEN (array_agg(score ORDER BY pct DESC, attempt_no DESC))[1]
                                   WHEN 'latest' THEN (array_agg(score ORDER BY attempt_no DESC))[1]
                                   ELSE round(avg(score), 2) END,
           'maxScore', CASE s.scoring WHEN 'highest' THEN (array_agg(max_score ORDER BY pct DESC, attempt_no DESC))[1]
                                      WHEN 'latest' THEN (array_agg(max_score ORDER BY attempt_no DESC))[1]
                                      ELSE round(avg(max_score), 2) END,
           'percent', CASE s.scoring WHEN 'highest' THEN max(pct)
                                     WHEN 'latest' THEN (array_agg(pct ORDER BY attempt_no DESC))[1]
                                     ELSE round(avg(pct), 2) END) END
    INTO counted
    FROM (SELECT a.score, a.max_score, a.attempt_no,
                 CASE WHEN a.max_score > 0 THEN round(a.score * 100 / a.max_score, 2) ELSE 0 END AS pct
            FROM lms.attempts a
           WHERE a.tenant_id = p_tenant AND a.assessment_item_id = p_item AND a.participant_id = g.participant_id
             AND a.status = 'graded' AND lms.results_visible(s.results_visibility, eff_close, a.released_at)) x;

  RETURN jsonb_build_object(
    'result', 'ok',
    'serverNow', now(),
    'assessment', jsonb_build_object(
      'itemId', p_item, 'title', title, 'kind', s.kind, 'opensAt', s.opens_at, 'closesAt', my_close,
      'timeLimitMinutes', s.time_limit_minutes, 'extraMinutes', coalesce(acc.extra_minutes, 0),
      'attemptsAllowed', s.attempts_allowed, 'scoring', s.scoring, 'passingScore', s.passing_score,
      'resultsVisibility', s.results_visibility, 'answersVisibility', s.answers_visibility,
      'questionCount', questions),
    'attemptsUsed', used,
    'canStart', blocked IS NULL AND NOT has_active,
    'blockedReason', blocked,
    'activeAttemptId', (SELECT a.id FROM lms.attempts a
                         WHERE a.tenant_id = p_tenant AND a.assessment_item_id = p_item
                           AND a.participant_id = g.participant_id AND a.status = 'in_progress'),
    'counted', counted,
    'attempts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id, 'attemptNo', a.attempt_no, 'status', a.status, 'startedAt', a.started_at,
               'submittedAt', a.submitted_at,
               'resultsVisible', a.status <> 'in_progress' AND lms.results_visible(s.results_visibility, eff_close, a.released_at),
               'score', CASE WHEN a.status = 'graded' AND lms.results_visible(s.results_visibility, eff_close, a.released_at) THEN a.score END,
               'maxScore', CASE WHEN a.status = 'graded' AND lms.results_visible(s.results_visibility, eff_close, a.released_at) THEN a.max_score END,
               'pendingGrading', a.status = 'submitted')
             ORDER BY a.attempt_no)
        FROM lms.attempts a
       WHERE a.tenant_id = p_tenant AND a.assessment_item_id = p_item AND a.participant_id = g.participant_id), '[]'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION lms.assessment_me(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_me(uuid, uuid, uuid, uuid, integer) TO lms_app;

-- ------------------------------------------------------------------ the result of one attempt (follows the visibility settings)
-- Score and per-question marks when results are visible; the correct answers and explanations ONLY when the answer
-- visibility allows them too. Anything else is a short message and no data.
CREATE FUNCTION lms.attempt_result(p_tenant uuid, p_user uuid, p_offering uuid, p_attempt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  att lms.attempts;
  s lms.assessments;
  eff_close timestamptz;
  show_score boolean;
  show_answers boolean;
BEGIN
  SELECT a.* INTO att FROM lms.attempts a
   WHERE a.tenant_id = p_tenant AND a.id = p_attempt AND a.offering_id = p_offering
     AND EXISTS (SELECT 1 FROM lms.course_participants cp
                   JOIN lms.tenant_memberships tm ON tm.tenant_id = cp.tenant_id AND tm.id = cp.membership_id
                  WHERE cp.tenant_id = a.tenant_id AND cp.id = a.participant_id
                    AND tm.user_id = p_user AND tm.status = 'active');
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF att.status = 'in_progress' THEN RETURN jsonb_build_object('result', 'in_progress'); END IF;
  SELECT * INTO s FROM lms.assessments WHERE tenant_id = p_tenant AND item_id = att.assessment_item_id;
  eff_close := lms.assessment_effective_close(p_tenant, att.assessment_item_id);
  show_score := lms.results_visible(s.results_visibility, eff_close, att.released_at);
  show_answers := show_score AND att.status = 'graded'
                  AND lms.results_visible(s.answers_visibility, eff_close, att.released_at);
  IF NOT show_score THEN
    RETURN jsonb_build_object('result', 'not_released', 'attempt', jsonb_build_object(
      'id', att.id, 'attemptNo', att.attempt_no, 'status', att.status, 'submittedAt', att.submitted_at));
  END IF;
  RETURN jsonb_build_object(
    'result', 'ok',
    'attempt', jsonb_build_object(
      'id', att.id, 'itemId', att.assessment_item_id, 'attemptNo', att.attempt_no, 'status', att.status,
      'submittedAt', att.submitted_at, 'feedback', att.feedback,
      'pendingGrading', att.status = 'submitted',
      'score', CASE WHEN att.status = 'graded' THEN att.score END,
      'maxScore', CASE WHEN att.status = 'graded' THEN att.max_score END,
      'percent', CASE WHEN att.status = 'graded' AND att.max_score > 0 THEN round(att.score * 100 / att.max_score, 2) END,
      'passed', CASE WHEN att.status = 'graded' AND s.passing_score IS NOT NULL AND att.max_score > 0
                     THEN att.score * 100 / att.max_score >= s.passing_score END,
      'answersShown', show_answers),
    'questions', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'position', aq.position, 'type', v.type, 'points', aq.points, 'dropped', aq.dropped,
          'stem', v.presentation -> 'stem', 'images', coalesce(v.presentation -> 'images', '[]'::jsonb),
          'options', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o -> 'text')
                                                ORDER BY array_position(aq.option_order, o ->> 'id'))
                                 FROM jsonb_array_elements(coalesce(v.presentation -> 'options', '[]'::jsonb)) o), '[]'::jsonb),
          'answer', aq.answer,
          'score', CASE WHEN att.status = 'graded' OR aq.manual_state <> 'pending' THEN aq.score END,
          'pendingGrading', aq.manual_state = 'pending',
          'feedback', aq.feedback)
        || CASE WHEN show_answers THEN jsonb_build_object('key', k.answer_key) ELSE '{}'::jsonb END
        ORDER BY aq.position)
        FROM lms.attempt_questions aq
        JOIN LATERAL (SELECT vv.type, vv.presentation FROM lms.question_versions vv
                       WHERE vv.tenant_id = aq.tenant_id AND vv.id = aq.question_version_id OFFSET 0) v ON true
        JOIN LATERAL (SELECT vk.answer_key FROM lms.question_versions vk
                       WHERE vk.tenant_id = aq.tenant_id AND vk.id = aq.scored_version_id OFFSET 0) k ON true
       WHERE aq.tenant_id = p_tenant AND aq.attempt_id = p_attempt), '[]'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION lms.attempt_result(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.attempt_result(uuid, uuid, uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ the interface the gradebook (step 11) will consume
-- One row per learner and assessment: the score that COUNTS under the assessment's policy (highest / latest / average
-- of the fully graded attempts), the number of attempts it is based on, and whether results were released. Runs with the
-- caller's rights: row-level security limits it to the current college, the caller checks the offering.
CREATE FUNCTION lms.assessment_final_scores(p_tenant uuid, p_offering uuid)
RETURNS TABLE (item_id uuid, participant_id uuid, attempts_graded integer, score numeric, max_score numeric,
               percent numeric, scoring text, released boolean, passing_score numeric)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT x.item_id, x.participant_id, count(*)::integer,
         CASE s.scoring WHEN 'highest' THEN (array_agg(x.score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.score), 2) END,
         CASE s.scoring WHEN 'highest' THEN (array_agg(x.max_score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.max_score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.max_score), 2) END,
         CASE s.scoring WHEN 'highest' THEN max(x.pct)
                        WHEN 'latest' THEN (array_agg(x.pct ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.pct), 2) END,
         s.scoring, bool_or(x.released_at IS NOT NULL), s.passing_score
    FROM (SELECT a.assessment_item_id AS item_id, a.participant_id, a.attempt_no, a.score, a.max_score, a.released_at,
                 CASE WHEN a.max_score > 0 THEN round(a.score * 100 / a.max_score, 2) ELSE 0 END AS pct
            FROM lms.attempts a
           WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering AND a.status = 'graded') x
    JOIN lms.assessments s ON s.tenant_id = p_tenant AND s.item_id = x.item_id
   GROUP BY x.item_id, x.participant_id, s.scoring, s.passing_score
$$;
REVOKE ALL ON FUNCTION lms.assessment_final_scores(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_final_scores(uuid, uuid) TO lms_app;

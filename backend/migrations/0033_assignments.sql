-- Step 10: assignments (submissions, rubrics, grading, late penalties, blind grading).
--
-- An assignment is a content item of kind 'assignment' (settings in `assignments`). A learner SUBMITS: every submit is a
-- new immutable VERSION (`submissions`, history: nothing cascades into it, lms_app cannot delete or update it). The
-- version with the highest number is the one that counts. Uploads go through the file store first (`assignment_uploads`
-- = the draft, ephemeral, may cascade); finalizing turns the ready files of the draft into `submission_files`.
--
-- Learner calls are hardened SECURITY DEFINER functions on an autocommit connection (2 round trips with the session
-- lookup): assignment_upload_begin, assignment_submit, assignment_me, assignment_file_access.
--
-- Deadline fairness lives here and only here: the SERVER time of the finalize decides. An upload that STARTED before the
-- due date and is finalized within the grace period (env, passed as p_grace seconds) counts on time.
--
-- Late penalty: stored as `late_seconds` on the version; the percentage is computed from the assignment's policy (read
-- time) until the grade is RELEASED, when it is frozen on the grade (`penalty_percent`), so a later change of the policy
-- never changes a released score. The percentage is of the assignment's MAXIMUM points.

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
END
$$;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_kind_check
  CHECK (kind IN ('text', 'file', 'link', 'video', 'assessment', 'assignment'));
ALTER TABLE lms.content_items DROP CONSTRAINT content_items_completion_ck;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_completion_ck CHECK (
  completion IN ('manual', 'on_view', 'watch', 'on_submit')
  AND ((kind = 'video') = (completion = 'watch'))
  AND ((kind IN ('assessment', 'assignment')) = (completion = 'on_submit')));

CREATE OR REPLACE FUNCTION lms.content_item_completion_default()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  NEW.completion := CASE NEW.kind WHEN 'text' THEN 'manual' WHEN 'video' THEN 'watch'
                                  WHEN 'assessment' THEN 'on_submit' WHEN 'assignment' THEN 'on_submit'
                                  ELSE 'on_view' END;
  RETURN NEW;
END
$$;

-- ------------------------------------------------------------------ rubrics (per COURSE, versioned like questions)
CREATE TABLE lms.rubrics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  course_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_version_id uuid,
  archived_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rubrics_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT rubrics_course_key UNIQUE (tenant_id, course_id, id),
  CONSTRAINT rubrics_course_fk FOREIGN KEY (tenant_id, course_id)
    REFERENCES lms.courses (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX rubrics_course_idx ON lms.rubrics (tenant_id, course_id, id);

-- immutable: a grade points at the exact version it used. criteria =
-- [{ id, title, description, levels: [{ id, title, description, points }] }], validated by the service.
CREATE TABLE lms.rubric_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  rubric_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND octet_length(criteria::text) <= 100000),
  max_points numeric(8, 2) NOT NULL CHECK (max_points > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rubric_versions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT rubric_versions_number_key UNIQUE (tenant_id, rubric_id, version_no),
  CONSTRAINT rubric_versions_rubric_fk FOREIGN KEY (tenant_id, rubric_id)
    REFERENCES lms.rubrics (tenant_id, id) ON DELETE RESTRICT
);
-- same deferred cycle as questions (migration 0032)
ALTER TABLE lms.rubrics ADD CONSTRAINT rubrics_current_version_fk
  FOREIGN KEY (tenant_id, current_version_id) REFERENCES lms.rubric_versions (tenant_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- ------------------------------------------------------------------ settings
CREATE TABLE lms.assignments (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  course_id uuid NOT NULL,
  -- rich text (validated JSON, never HTML), like content text items
  instructions jsonb CHECK (instructions IS NULL OR octet_length(instructions::text) <= 200000),
  opens_at timestamptz,
  due_at timestamptz,
  -- 'none': nothing after the due date. 'allowed': late work until the hard cutoff, with an automatic penalty
  late_policy text NOT NULL DEFAULT 'none' CHECK (late_policy IN ('none', 'allowed')),
  late_cutoff_at timestamptz,
  penalty_kind text NOT NULL DEFAULT 'per_day' CHECK (penalty_kind IN ('per_day', 'flat')),
  -- percent of the maximum points: per started day, or once
  penalty_value numeric(5, 2) NOT NULL DEFAULT 10 CHECK (penalty_value BETWEEN 0 AND 100),
  -- the penalty never exceeds this percent
  penalty_cap numeric(5, 2) NOT NULL DEFAULT 50 CHECK (penalty_cap BETWEEN 0 AND 100),
  max_points numeric(7, 2) NOT NULL DEFAULT 100 CHECK (max_points > 0),
  passing_score numeric(5, 2) CHECK (passing_score BETWEEN 0 AND 100),
  allow_file boolean NOT NULL DEFAULT true,
  allow_text boolean NOT NULL DEFAULT false,
  allow_link boolean NOT NULL DEFAULT false,
  max_files smallint NOT NULL DEFAULT 3 CHECK (max_files BETWEEN 1 AND 10),
  max_file_mb smallint NOT NULL DEFAULT 25 CHECK (max_file_mb BETWEEN 1 AND 100),
  resubmission_allowed boolean NOT NULL DEFAULT true,
  anonymous_grading boolean NOT NULL DEFAULT false,
  -- 'manual': a grade is visible only after release; 'immediate': as soon as it is saved
  release_mode text NOT NULL DEFAULT 'manual' CHECK (release_mode IN ('manual', 'immediate')),
  rubric_id uuid,
  rubric_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  CONSTRAINT assignments_window_ck CHECK (due_at IS NULL OR opens_at IS NULL OR due_at > opens_at),
  CONSTRAINT assignments_late_ck CHECK (
    late_policy = 'none' OR (due_at IS NOT NULL AND late_cutoff_at IS NOT NULL AND late_cutoff_at > due_at)),
  CONSTRAINT assignments_types_ck CHECK (allow_file OR allow_text OR allow_link),
  CONSTRAINT assignments_rubric_ck CHECK ((rubric_id IS NULL) = (rubric_version_id IS NULL)),
  CONSTRAINT assignments_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.content_items (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT assignments_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  -- the rubric belongs to the SAME course
  CONSTRAINT assignments_rubric_fk FOREIGN KEY (tenant_id, course_id, rubric_id)
    REFERENCES lms.rubrics (tenant_id, course_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignments_rubric_version_fk FOREIGN KEY (tenant_id, rubric_version_id)
    REFERENCES lms.rubric_versions (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assignments_offering_idx ON lms.assignments (tenant_id, offering_id);

CREATE FUNCTION lms.assignment_default_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  -- ON CONFLICT: the offering copy inserts the copied settings in the same statement; this row is only the fallback
  INSERT INTO lms.assignments (tenant_id, item_id, offering_id, course_id)
  SELECT NEW.tenant_id, NEW.id, NEW.offering_id, o.course_id
    FROM lms.course_offerings o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.offering_id
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_default_row() FROM PUBLIC;
CREATE TRIGGER content_items_assignment_row AFTER INSERT ON lms.content_items
  FOR EACH ROW WHEN (NEW.kind = 'assignment') EXECUTE FUNCTION lms.assignment_default_row();

-- the same fallback for assessments: an offering copy now brings the settings along (explicit insert in the copy statement)
CREATE OR REPLACE FUNCTION lms.assessment_default_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  INSERT INTO lms.assessments (tenant_id, item_id, offering_id, course_id)
  SELECT NEW.tenant_id, NEW.id, NEW.offering_id, o.course_id
    FROM lms.course_offerings o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.offering_id
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

-- instructor attachments (reference protects the file from the purge)
CREATE TABLE lms.assignment_attachments (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  file_id uuid NOT NULL,
  position smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, assignment_item_id, file_id),
  CONSTRAINT assignment_attachments_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT assignment_attachments_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assignment_attachments_file_idx ON lms.assignment_attachments (tenant_id, file_id);

-- per-learner extension of the due date (the hard cutoff moves by the same amount). SENSITIVE like accommodations:
-- `reason` is read only by the extension endpoints, never in a list or an export, never in the audit log.
CREATE TABLE lms.assignment_extensions (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  extended_due_at timestamptz NOT NULL,
  reason text CHECK (length(reason) <= 300),
  set_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assignment_item_id, participant_id),
  CONSTRAINT assignment_extensions_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT assignment_extensions_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);

-- the address of a learner while grading: a random key (what the grading screens and URLs carry) and a short
-- anonymous code (what blind graders see). Neither can be derived from the participant id or a name.
CREATE TABLE lms.assignment_learners (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  learner_key uuid NOT NULL,
  anon_code text NOT NULL CHECK (anon_code ~ '^[A-Z2-9]{6}$'),
  PRIMARY KEY (tenant_id, assignment_item_id, participant_id),
  CONSTRAINT assignment_learners_key_key UNIQUE (tenant_id, learner_key),
  CONSTRAINT assignment_learners_code_key UNIQUE (tenant_id, assignment_item_id, anon_code),
  CONSTRAINT assignment_learners_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT assignment_learners_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION lms.anon_code()
RETURNS text LANGUAGE sql VOLATILE SET search_path = lms, pg_temp
AS $$
  SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1), '')
    FROM generate_series(1, 6)
$$;

-- ------------------------------------------------------------------ drafts (uploaded files not yet part of a submission)
CREATE TABLE lms.assignment_uploads (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  file_id uuid NOT NULL,
  assignment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_id),
  -- ephemeral: an upload that never became part of a submission is purged with its file
  CONSTRAINT assignment_uploads_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT assignment_uploads_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE CASCADE,
  CONSTRAINT assignment_uploads_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assignment_uploads_draft_idx ON lms.assignment_uploads (tenant_id, assignment_item_id, participant_id);

-- ------------------------------------------------------------------ submissions (history: never deleted, never updated)
CREATE TABLE lms.submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  version_no smallint NOT NULL CHECK (version_no >= 1),
  text_body text CHECK (length(text_body) <= 50000),
  link_url text CHECK (length(link_url) <= 2000 AND link_url ~ '^https?://'),
  -- a client-made key: the same finalize sent twice (double click, retry) is ONE version
  request_key uuid NOT NULL,
  -- the SERVER time of the finalize
  submitted_at timestamptz NOT NULL DEFAULT now(),
  late_seconds integer NOT NULL DEFAULT 0 CHECK (late_seconds >= 0),
  -- counted on time only because the upload began before the due date (grace period)
  on_grace boolean NOT NULL DEFAULT false,
  CONSTRAINT submissions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT submissions_number_key UNIQUE (tenant_id, assignment_item_id, participant_id, version_no),
  CONSTRAINT submissions_request_key UNIQUE (tenant_id, assignment_item_id, participant_id, request_key),
  CONSTRAINT submissions_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT submissions_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX submissions_time_idx ON lms.submissions (tenant_id, assignment_item_id, submitted_at, id);

CREATE TABLE lms.submission_files (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  submission_id uuid NOT NULL,
  file_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position >= 1),
  PRIMARY KEY (tenant_id, submission_id, file_id),
  CONSTRAINT submission_files_submission_fk FOREIGN KEY (tenant_id, submission_id)
    REFERENCES lms.submissions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT submission_files_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX submission_files_file_idx ON lms.submission_files (tenant_id, file_id);

-- ------------------------------------------------------------------ grades
CREATE TABLE lms.assignment_grades (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  -- the VERSION this grade is for; a newer version makes the grade "older than the latest"
  submission_id uuid NOT NULL,
  rubric_version_id uuid,
  -- { criterionId: { levelId, points, comment } }
  rubric_selection jsonb CHECK (rubric_selection IS NULL OR octet_length(rubric_selection::text) <= 100000),
  rubric_score numeric(8, 2) CHECK (rubric_score >= 0),
  -- the score that counts BEFORE the late penalty: the rubric's, or the grader's override
  raw_score numeric(8, 2) NOT NULL CHECK (raw_score >= 0),
  override_reason text CHECK (length(override_reason) <= 500),
  feedback jsonb CHECK (feedback IS NULL OR octet_length(feedback::text) <= 100000),
  -- frozen at release; before that the penalty is computed from the policy
  penalty_percent numeric(5, 2) CHECK (penalty_percent BETWEEN 0 AND 100),
  penalty_waived boolean NOT NULL DEFAULT false,
  waive_reason text CHECK (length(waive_reason) <= 500),
  waived_by uuid,
  graded_by uuid NOT NULL,
  graded_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assignment_item_id, participant_id),
  CONSTRAINT assignment_grades_override_ck CHECK (
    rubric_score IS NULL OR raw_score = rubric_score OR override_reason IS NOT NULL),
  CONSTRAINT assignment_grades_waive_ck CHECK (NOT penalty_waived OR waive_reason IS NOT NULL),
  CONSTRAINT assignment_grades_submission_fk FOREIGN KEY (tenant_id, submission_id)
    REFERENCES lms.submissions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_grades_assignment_fk FOREIGN KEY (tenant_id, assignment_item_id)
    REFERENCES lms.assignments (tenant_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT assignment_grades_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT assignment_grades_rubric_version_fk FOREIGN KEY (tenant_id, rubric_version_id)
    REFERENCES lms.rubric_versions (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assignment_grades_submission_idx ON lms.assignment_grades (tenant_id, submission_id);

CREATE TABLE lms.assignment_feedback_files (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  assignment_item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  file_id uuid NOT NULL,
  position smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, assignment_item_id, participant_id, file_id),
  CONSTRAINT assignment_feedback_files_grade_fk FOREIGN KEY (tenant_id, assignment_item_id, participant_id)
    REFERENCES lms.assignment_grades (tenant_id, assignment_item_id, participant_id) ON DELETE CASCADE,
  CONSTRAINT assignment_feedback_files_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX assignment_feedback_files_file_idx ON lms.assignment_feedback_files (tenant_id, file_id);

-- ------------------------------------------------------------------ RLS, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rubrics', 'rubric_versions', 'assignments', 'assignment_attachments',
                           'assignment_extensions', 'assignment_learners', 'assignment_uploads', 'submissions',
                           'submission_files', 'assignment_grades', 'assignment_feedback_files']
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
GRANT SELECT, INSERT ON lms.rubrics, lms.rubric_versions TO lms_app;
GRANT UPDATE (title, current_version_id, archived_at, updated_at) ON lms.rubrics TO lms_app;
GRANT SELECT ON lms.assignments TO lms_app;
GRANT UPDATE (instructions, opens_at, due_at, late_policy, late_cutoff_at, penalty_kind, penalty_value, penalty_cap,
              max_points, passing_score, allow_file, allow_text, allow_link, max_files, max_file_mb,
              resubmission_allowed, anonymous_grading, release_mode, rubric_id, rubric_version_id, updated_at)
  ON lms.assignments TO lms_app;
-- the offering copy writes the copied settings and attachments in its one statement
GRANT INSERT ON lms.assignments TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.assignment_attachments TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.assignment_extensions TO lms_app;
GRANT UPDATE (extended_due_at, reason, set_by, updated_at) ON lms.assignment_extensions TO lms_app;
GRANT SELECT, INSERT ON lms.assignment_learners TO lms_app;
-- uploads and submissions are written only by the definer functions; instructors read them
GRANT SELECT ON lms.assignment_uploads, lms.submissions, lms.submission_files TO lms_app;
GRANT SELECT, INSERT ON lms.assignment_grades TO lms_app;
GRANT UPDATE (submission_id, rubric_version_id, rubric_selection, rubric_score, raw_score, override_reason, feedback,
              penalty_percent, penalty_waived, waive_reason, waived_by, graded_by, graded_at, released_at,
              released_by, updated_at)
  ON lms.assignment_grades TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.assignment_feedback_files TO lms_app;

-- ------------------------------------------------------------------ files are purged only when nothing refers to them
CREATE OR REPLACE FUNCTION lms.files_purge(p_grace interval, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH doomed AS (
    SELECT f.tenant_id, f.id
      FROM lms.files f
     WHERE greatest(coalesce(f.confirmed_at, f.created_at), coalesce(f.last_unreferenced_at, f.created_at))
             < now() - p_grace
       AND NOT EXISTS (SELECT 1 FROM lms.content_items i WHERE i.tenant_id = f.tenant_id AND i.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM lms.question_files q WHERE q.tenant_id = f.tenant_id AND q.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM lms.submission_files s WHERE s.tenant_id = f.tenant_id AND s.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM lms.assignment_attachments a WHERE a.tenant_id = f.tenant_id AND a.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM lms.assignment_feedback_files b WHERE b.tenant_id = f.tenant_id AND b.file_id = f.id)
     ORDER BY f.created_at, f.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE OF f SKIP LOCKED
  )
  DELETE FROM lms.files f USING doomed d
   WHERE f.tenant_id = d.tenant_id AND f.id = d.id
  RETURNING f.storage_key
$$;

-- ------------------------------------------------------------------ helpers
-- The penalty in percent of the maximum points for work `late_seconds` late. per_day counts every STARTED day (one
-- second late is one day); flat is charged once; never more than the cap. IMMUTABLE: a pure function of its arguments.
CREATE FUNCTION lms.assignment_penalty_percent(p_kind text, p_value numeric, p_cap numeric, p_late_seconds integer)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$
  SELECT CASE WHEN p_late_seconds <= 0 THEN 0::numeric
              WHEN p_kind = 'flat' THEN least(p_value, p_cap)
              ELSE least(ceil(p_late_seconds / 86400.0) * p_value, p_cap) END
$$;

-- The due date and the hard cutoff THIS participant has: the assignment's, or the extension's (the cutoff moves by the
-- same amount). Without a late policy the cutoff is the due date. NULL due = never late.
CREATE FUNCTION lms.assignment_timing(p_tenant uuid, p_item uuid, p_participant uuid)
RETURNS TABLE (due timestamptz, cutoff timestamptz, extended boolean)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT d.due,
         CASE WHEN d.due IS NULL THEN NULL
              WHEN a.late_policy = 'allowed' THEN a.late_cutoff_at + greatest(d.due - a.due_at, interval '0')
              ELSE d.due END,
         x.extended_due_at IS NOT NULL AND x.extended_due_at > a.due_at
    FROM lms.assignments a
    LEFT JOIN lms.assignment_extensions x
           ON x.tenant_id = a.tenant_id AND x.assignment_item_id = a.item_id AND x.participant_id = p_participant
    CROSS JOIN LATERAL (SELECT CASE WHEN a.due_at IS NULL THEN NULL
                                    ELSE greatest(a.due_at, coalesce(x.extended_due_at, a.due_at)) END AS due) d
   WHERE a.tenant_id = p_tenant AND a.item_id = p_item
$$;

-- the score after the penalty of a grade: raw minus (maximum x percent), never below zero; the percent is frozen at release
CREATE FUNCTION lms.assignment_final_points(p_raw numeric, p_max numeric, p_percent numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$ SELECT greatest(0, round(p_raw - p_max * p_percent / 100, 2)) $$;

-- ------------------------------------------------------------------ upload begin (one call)
-- Records the PENDING file and the draft entry in ONE statement for a learner who may submit now. The caller (service)
-- built the storage key and decided the type from the allowlist; this function enforces the rules of the assignment:
-- window, enabled types, file size and count, resubmission. Returns { result: 'ok' | refusal }.
CREATE FUNCTION lms.assignment_upload_begin(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid,
                                            p_storage_key text, p_name text, p_content_type text, p_size bigint,
                                            p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  t record;
  drafts integer;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assignment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  IF NOT a.allow_file THEN RETURN jsonb_build_object('result', 'files_not_allowed'); END IF;
  IF p_size > a.max_file_mb::bigint * 1048576 THEN
    RETURN jsonb_build_object('result', 'file_too_large', 'maxMb', a.max_file_mb);
  END IF;
  IF a.opens_at IS NOT NULL AND now() < a.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  SELECT * INTO t FROM lms.assignment_timing(p_tenant, p_item, g.participant_id);
  IF t.due IS NOT NULL AND now() > t.cutoff THEN RETURN jsonb_build_object('result', 'closed'); END IF;
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
  INSERT INTO lms.assignment_uploads (tenant_id, file_id, assignment_item_id, participant_id)
  VALUES (p_tenant, p_file, p_item, g.participant_id);
  RETURN jsonb_build_object('result', 'ok', 'maxMb', a.max_file_mb, 'maxFiles', a.max_files);
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_upload_begin(uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_upload_begin(uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, integer) TO lms_app;

-- ------------------------------------------------------------------ finalize (one call)
-- The learner hands in: text, a link and / or the READY files of their draft. A new VERSION is written; the latest
-- version counts. When the new version is late and the one that counts now was on time, the learner must CONFIRM
-- (p_confirm_late) after seeing the exact penalty: without it nothing is written and the answer is 'confirm_late'.
-- Returns { result: 'ok' | 'confirm_late' | refusal, ... }.
CREATE FUNCTION lms.assignment_submit(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_request_key uuid,
                                      p_text text, p_link text, p_files uuid[], p_confirm_late boolean,
                                      p_grace integer)
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
  IF a.opens_at IS NOT NULL AND now() < a.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
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
  IF t.due IS NOT NULL AND now() > t.due THEN
    IF first_upload IS NOT NULL AND first_upload <= t.due AND now() <= t.due + make_interval(secs => p_grace) THEN
      grace := true;
    ELSIF a.late_policy = 'allowed' AND now() <= t.cutoff THEN
      late := ceil(extract(epoch FROM now() - t.due))::integer;
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
                               link_url, request_key, late_seconds, on_grace)
  VALUES (new_id, p_tenant, p_item, p_offering, g.participant_id, nver, body, link, p_request_key, late, grace);
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
REVOKE ALL ON FUNCTION lms.assignment_submit(uuid, uuid, uuid, uuid, uuid, text, text, uuid[], boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_submit(uuid, uuid, uuid, uuid, uuid, text, text, uuid[], boolean, integer) TO lms_app;

-- ------------------------------------------------------------------ the learner's page (one call)
-- Settings (with THEIR dates), their versions, their draft uploads and their grade when it may be seen. Never another
-- learner's data, never the extension reason, never a blind code.
CREATE FUNCTION lms.assignment_me(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_grace integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  t record;
  title text;
  latest lms.submissions;
  gr lms.assignment_grades;
  late_now integer := 0;
  pct_now numeric := 0;
  state text;
  grace_ok boolean := false;
  grade_json jsonb := NULL;
  visible boolean := false;
  pct numeric;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assignment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  SELECT i.title INTO title FROM lms.content_items i WHERE i.tenant_id = p_tenant AND i.id = p_item;
  SELECT * INTO t FROM lms.assignment_timing(p_tenant, p_item, g.participant_id);
  SELECT * INTO latest FROM lms.submissions
   WHERE tenant_id = p_tenant AND assignment_item_id = p_item AND participant_id = g.participant_id
   ORDER BY version_no DESC LIMIT 1;

  IF t.due IS NOT NULL AND now() > t.due THEN
    late_now := ceil(extract(epoch FROM now() - t.due))::integer;
    pct_now := lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, late_now);
    grace_ok := EXISTS (SELECT 1 FROM lms.assignment_uploads u
                         WHERE u.tenant_id = p_tenant AND u.assignment_item_id = p_item
                           AND u.participant_id = g.participant_id AND u.created_at <= t.due)
                AND now() <= t.due + make_interval(secs => p_grace);
  END IF;
  state := CASE WHEN a.opens_at IS NOT NULL AND now() < a.opens_at THEN 'not_open'
                WHEN t.due IS NULL OR now() <= t.due THEN 'open'
                WHEN a.late_policy = 'allowed' AND now() <= t.cutoff THEN 'late'
                ELSE 'closed' END;

  SELECT * INTO gr FROM lms.assignment_grades
   WHERE tenant_id = p_tenant AND assignment_item_id = p_item AND participant_id = g.participant_id;
  visible := FOUND AND (gr.released_at IS NOT NULL OR a.release_mode = 'immediate');
  IF visible THEN
    pct := CASE WHEN gr.penalty_waived THEN 0
                WHEN gr.penalty_percent IS NOT NULL THEN gr.penalty_percent
                ELSE lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap,
                       coalesce((SELECT s.late_seconds FROM lms.submissions s
                                  WHERE s.tenant_id = p_tenant AND s.id = gr.submission_id), 0)) END;
    grade_json := jsonb_build_object(
      'submissionVersionNo', (SELECT s.version_no FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.id = gr.submission_id),
      'rawScore', gr.raw_score, 'penaltyPercent', pct,
      'penaltyPoints', round(a.max_points * pct / 100, 2), 'penaltyWaived', gr.penalty_waived,
      'finalScore', lms.assignment_final_points(gr.raw_score, a.max_points, pct),
      'maxPoints', a.max_points, 'passingScore', a.passing_score,
      'feedback', gr.feedback, 'gradedAt', gr.graded_at, 'releasedAt', gr.released_at,
      'overridden', gr.rubric_score IS NOT NULL AND gr.raw_score <> gr.rubric_score,
      'rubric', CASE WHEN gr.rubric_version_id IS NULL THEN NULL ELSE jsonb_build_object(
                  'criteria', (SELECT rv.criteria FROM lms.rubric_versions rv
                                WHERE rv.tenant_id = p_tenant AND rv.id = gr.rubric_version_id),
                  'selection', gr.rubric_selection) END,
      'files', coalesce((SELECT jsonb_agg(jsonb_build_object('fileId', f.id, 'name', f.original_name,
                                                             'size', f.size_bytes, 'contentType', f.content_type)
                                          ORDER BY ff.position)
                           FROM lms.assignment_feedback_files ff
                           JOIN lms.files f ON f.tenant_id = ff.tenant_id AND f.id = ff.file_id
                          WHERE ff.tenant_id = p_tenant AND ff.assignment_item_id = p_item
                            AND ff.participant_id = g.participant_id), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object(
    'result', 'ok', 'serverNow', now(), 'graceSeconds', p_grace,
    'assignment', jsonb_build_object(
      'itemId', p_item, 'title', title, 'instructions', a.instructions, 'opensAt', a.opens_at,
      'dueAt', t.due, 'originalDueAt', a.due_at, 'hasExtension', coalesce(t.extended, false),
      'latePolicy', a.late_policy, 'lateCutoffAt', t.cutoff, 'penaltyKind', a.penalty_kind,
      'penaltyValue', a.penalty_value, 'penaltyCap', a.penalty_cap, 'maxPoints', a.max_points,
      'passingScore', a.passing_score, 'allowFile', a.allow_file, 'allowText', a.allow_text,
      'allowLink', a.allow_link, 'maxFiles', a.max_files, 'maxFileMb', a.max_file_mb,
      'resubmissionAllowed', a.resubmission_allowed, 'anonymousGrading', a.anonymous_grading,
      'releaseMode', a.release_mode,
      'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object('fileId', f.id, 'name', f.original_name,
                                                                   'size', f.size_bytes, 'contentType', f.content_type)
                                                ORDER BY at.position)
                                 FROM lms.assignment_attachments at
                                 JOIN lms.files f ON f.tenant_id = at.tenant_id AND f.id = at.file_id
                                WHERE at.tenant_id = p_tenant AND at.assignment_item_id = p_item), '[]'::jsonb)),
    'state', state,
    'canSubmit', (state IN ('open', 'late') OR grace_ok) AND (latest.id IS NULL OR a.resubmission_allowed),
    'draftWithinGrace', grace_ok,
    'lateSecondsNow', late_now, 'penaltyPercentNow', pct_now,
    'penaltyPointsNow', round(a.max_points * pct_now / 100, 2),
    'counts', CASE WHEN latest.id IS NULL THEN NULL ELSE latest.version_no END,
    'submissions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'versionNo', s.version_no, 'submittedAt', s.submitted_at, 'lateSeconds', s.late_seconds,
               'onGrace', s.on_grace, 'text', s.text_body, 'link', s.link_url,
               'penaltyPercent', lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, s.late_seconds),
               'files', coalesce((SELECT jsonb_agg(jsonb_build_object('fileId', f.id, 'name', f.original_name,
                                                                      'size', f.size_bytes, 'contentType', f.content_type)
                                                   ORDER BY sf.position)
                                    FROM lms.submission_files sf
                                    JOIN lms.files f ON f.tenant_id = sf.tenant_id AND f.id = sf.file_id
                                   WHERE sf.tenant_id = s.tenant_id AND sf.submission_id = s.id), '[]'::jsonb))
             ORDER BY s.version_no DESC)
        FROM (SELECT * FROM lms.submissions x
               WHERE x.tenant_id = p_tenant AND x.assignment_item_id = p_item AND x.participant_id = g.participant_id
               ORDER BY x.version_no DESC LIMIT 20) s), '[]'::jsonb),
    'drafts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('fileId', f.id, 'name', f.original_name, 'size', f.declared_size,
                                          'status', f.status, 'createdAt', u.created_at) ORDER BY u.created_at)
        FROM lms.assignment_uploads u
        JOIN lms.files f ON f.tenant_id = u.tenant_id AND f.id = u.file_id
       WHERE u.tenant_id = p_tenant AND u.assignment_item_id = p_item AND u.participant_id = g.participant_id), '[]'::jsonb),
    'grade', grade_json);
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_me(uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_me(uuid, uuid, uuid, uuid, integer) TO lms_app;

-- ------------------------------------------------------------------ a learner downloads a file (one call)
-- Allowed: an instructor attachment of an assignment the learner can see, a file of THEIR OWN submission or draft, and a
-- feedback file of THEIR grade once it is visible. Anything else answers 'not_found' (never says the file exists).
CREATE FUNCTION lms.assignment_file_access(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid)
RETURNS TABLE (result text, storage_key text, original_name text, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  ok boolean;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' OR g.kind <> 'assignment' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  ok := EXISTS (SELECT 1 FROM lms.assignment_attachments x
                 WHERE x.tenant_id = p_tenant AND x.assignment_item_id = p_item AND x.file_id = p_file)
     OR EXISTS (SELECT 1 FROM lms.submission_files sf
                  JOIN lms.submissions s ON s.tenant_id = sf.tenant_id AND s.id = sf.submission_id
                 WHERE sf.tenant_id = p_tenant AND sf.file_id = p_file AND s.assignment_item_id = p_item
                   AND s.participant_id = g.participant_id)
     OR EXISTS (SELECT 1 FROM lms.assignment_uploads u
                 WHERE u.tenant_id = p_tenant AND u.file_id = p_file AND u.assignment_item_id = p_item
                   AND u.participant_id = g.participant_id)
     OR EXISTS (SELECT 1 FROM lms.assignment_feedback_files ff
                  JOIN lms.assignment_grades gr ON gr.tenant_id = ff.tenant_id
                   AND gr.assignment_item_id = ff.assignment_item_id AND gr.participant_id = ff.participant_id
                 WHERE ff.tenant_id = p_tenant AND ff.file_id = p_file AND ff.assignment_item_id = p_item
                   AND ff.participant_id = g.participant_id
                   AND (gr.released_at IS NOT NULL OR a.release_mode = 'immediate'));
  IF NOT ok THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, f.storage_key, f.original_name, f.content_type
                 FROM lms.files f WHERE f.tenant_id = p_tenant AND f.id = p_file AND f.status = 'ready';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_file_access(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_file_access(uuid, uuid, uuid, uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ the interface the gradebook (step 11) will consume
-- One row per learner and assignment that has a grade: the score that COUNTS (after the penalty; the percent is frozen at
-- release), the maximum, the penalty and whether it was released (release_mode 'immediate' counts as released). Runs with
-- the caller's rights: row-level security limits it to the current college, the caller checks the offering.
CREATE FUNCTION lms.assignment_final_scores(p_tenant uuid, p_offering uuid)
RETURNS TABLE (item_id uuid, participant_id uuid, raw_score numeric, penalty_percent numeric, score numeric,
               max_score numeric, percent numeric, released boolean, passing_score numeric, late boolean)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT gr.assignment_item_id, gr.participant_id, gr.raw_score, pen.pct,
         lms.assignment_final_points(gr.raw_score, a.max_points, pen.pct), a.max_points,
         round(lms.assignment_final_points(gr.raw_score, a.max_points, pen.pct) * 100 / a.max_points, 2),
         (gr.released_at IS NOT NULL OR a.release_mode = 'immediate'), a.passing_score, s.late_seconds > 0
    FROM lms.assignment_grades gr
    JOIN lms.assignments a ON a.tenant_id = gr.tenant_id AND a.item_id = gr.assignment_item_id
    JOIN lms.submissions s ON s.tenant_id = gr.tenant_id AND s.id = gr.submission_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN gr.penalty_waived THEN 0::numeric
                  WHEN gr.penalty_percent IS NOT NULL THEN gr.penalty_percent
                  ELSE lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, s.late_seconds)
             END AS pct) pen
   WHERE gr.tenant_id = p_tenant AND a.offering_id = p_offering
$$;
REVOKE ALL ON FUNCTION lms.assignment_final_scores(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_final_scores(uuid, uuid) TO lms_app;

-- Step 9a: the question bank. Questions belong to a COURSE (reusable by every offering of it). Editing a question
-- never changes a row: it adds a VERSION, and an attempt (migration 0029) points at the exact versions it showed.
--
-- What a learner may be sent (the stem, the options) and what must never reach a learner before results are released
-- (the answer key, the explanation) live in TWO columns of the version: `presentation` and `answer_key`. Learner-facing
-- code reads only `presentation`.

CREATE TABLE lms.questions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  course_id uuid NOT NULL,
  -- the version new papers are drawn from (deferred: the first version and the question are inserted together)
  current_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT questions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT questions_course_key UNIQUE (tenant_id, course_id, id),
  CONSTRAINT questions_course_fk FOREIGN KEY (tenant_id, course_id)
    REFERENCES lms.courses (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX questions_course_idx ON lms.questions (tenant_id, course_id, status, id);

CREATE TABLE lms.question_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  question_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  type text NOT NULL CHECK (type IN
    ('single_choice', 'multiple_choice', 'true_false', 'numeric', 'short_answer', 'essay')),
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  -- sent to learners: { stem: <rich text>, options?: [{ id, text }], images?: [{ fileId, alt }], maxWords? }
  presentation jsonb NOT NULL CHECK (octet_length(presentation::text) <= 300000),
  -- NEVER sent before release: { correct: [ids], partial? } | { value, tolerance, mode } | { accepted: [...], mode } | { explanation }
  answer_key jsonb NOT NULL CHECK (octet_length(answer_key::text) <= 100000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_versions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT question_versions_number_key UNIQUE (tenant_id, question_id, version),
  CONSTRAINT question_versions_question_fk FOREIGN KEY (tenant_id, question_id)
    REFERENCES lms.questions (tenant_id, id) ON DELETE RESTRICT
);
ALTER TABLE lms.questions ADD CONSTRAINT questions_current_version_fk
  FOREIGN KEY (tenant_id, current_version_id) REFERENCES lms.question_versions (tenant_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- tags organise the bank and feed the random pools; they belong to the QUESTION (not versioned)
CREATE TABLE lms.question_tags (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  course_id uuid NOT NULL,
  question_id uuid NOT NULL,
  tag text NOT NULL CHECK (tag = lower(btrim(tag)) AND length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY (tenant_id, question_id, tag),
  CONSTRAINT question_tags_question_fk FOREIGN KEY (tenant_id, course_id, question_id)
    REFERENCES lms.questions (tenant_id, course_id, id) ON DELETE CASCADE
);
CREATE INDEX question_tags_tag_idx ON lms.question_tags (tenant_id, course_id, tag, question_id);

-- images of a version: the reference that keeps the file from being purged, and that authorises a learner's download
CREATE TABLE lms.question_files (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  question_version_id uuid NOT NULL,
  file_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, question_version_id, file_id),
  CONSTRAINT question_files_version_fk FOREIGN KEY (tenant_id, question_version_id)
    REFERENCES lms.question_versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT question_files_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX question_files_file_idx ON lms.question_files (tenant_id, file_id);

-- a file referenced by a question version is not purged
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
     ORDER BY f.created_at, f.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE OF f SKIP LOCKED
  )
  DELETE FROM lms.files f USING doomed d
   WHERE f.tenant_id = d.tenant_id AND f.id = d.id
  RETURNING f.storage_key
$$;

-- ------------------------------------------------------------------ the CSV import (synchronous, at most 1,000 rows)
CREATE TABLE lms.question_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  course_id uuid NOT NULL,
  created_by uuid NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) <= 255),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'applied', 'cancelled')),
  total_rows integer NOT NULL CHECK (total_rows BETWEEN 0 AND 1000),
  valid_rows integer NOT NULL CHECK (valid_rows >= 0),
  created_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_imports_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT question_imports_course_fk FOREIGN KEY (tenant_id, course_id)
    REFERENCES lms.courses (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX question_imports_course_idx ON lms.question_imports (tenant_id, course_id, created_at DESC);

CREATE TABLE lms.question_import_rows (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  import_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no >= 1),
  -- the cleaned input and, when valid, the question it becomes ({ type, difficulty, tags, presentation, answerKey })
  raw jsonb NOT NULL,
  parsed jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, import_id, row_no),
  CONSTRAINT question_import_rows_import_fk FOREIGN KEY (tenant_id, import_id)
    REFERENCES lms.question_imports (tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ RLS, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['questions', 'question_versions', 'question_tags', 'question_files',
                           'question_imports', 'question_import_rows']
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
-- versions are immutable and nothing is deleted (history); tags and the import staging are working data
GRANT SELECT, INSERT ON lms.questions, lms.question_versions, lms.question_files TO lms_app;
GRANT UPDATE (current_version_id, status, updated_at) ON lms.questions TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.question_tags TO lms_app;
GRANT SELECT, INSERT ON lms.question_imports TO lms_app;
GRANT UPDATE (status, created_count) ON lms.question_imports TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.question_import_rows TO lms_app;

-- ------------------------------------------------------------------ scoring (pure; used set-based at submit and regrade)
-- Answer formats: choice {"o": [option ids]}, numeric {"n": number}, short answer / essay {"t": "text"}.
-- Text is compared after NFKC normalisation, trimming, collapsing white space and lower-casing.
CREATE FUNCTION lms.norm_text(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$ SELECT lower(regexp_replace(btrim(normalize(coalesce(p, ''), NFKC)), '\s+', ' ', 'g')) $$;

CREATE TYPE lms.score_result AS (score numeric, manual boolean);

CREATE FUNCTION lms.score_answer(p_type text, p_key jsonb, p_answer jsonb, p_points numeric)
RETURNS lms.score_result
LANGUAGE plpgsql IMMUTABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  picked text[];
  correct text[];
  right_n integer;
  wrong_n integer;
  v numeric;
  tol numeric;
  txt text;
BEGIN
  IF p_answer IS NULL OR p_answer = 'null'::jsonb THEN RETURN ROW(0, false)::lms.score_result; END IF;
  IF p_type IN ('single_choice', 'true_false', 'multiple_choice') THEN
    SELECT coalesce(array_agg(DISTINCT x), '{}') INTO picked
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_answer -> 'o') = 'array' THEN p_answer -> 'o' ELSE '[]'::jsonb END) x;
    SELECT coalesce(array_agg(x ORDER BY x), '{}') INTO correct FROM jsonb_array_elements_text(p_key -> 'correct') x;
    IF cardinality(picked) = 0 THEN RETURN ROW(0, false)::lms.score_result; END IF;
    IF p_type <> 'multiple_choice' THEN
      RETURN ROW(CASE WHEN cardinality(picked) = 1 AND picked = correct THEN p_points ELSE 0 END, false)::lms.score_result;
    END IF;
    right_n := (SELECT count(*) FROM unnest(picked) x WHERE x = ANY (correct));
    wrong_n := cardinality(picked) - right_n;
    IF coalesce((p_key ->> 'partial')::boolean, false) THEN
      RETURN ROW(round(p_points * greatest(0, right_n - wrong_n)::numeric / greatest(cardinality(correct), 1), 2), false)::lms.score_result;
    END IF;
    RETURN ROW(CASE WHEN wrong_n = 0 AND right_n = cardinality(correct) THEN p_points ELSE 0 END, false)::lms.score_result;
  ELSIF p_type = 'numeric' THEN
    BEGIN
      v := (p_answer ->> 'n')::numeric;
    EXCEPTION WHEN others THEN
      RETURN ROW(0, false)::lms.score_result;
    END;
    IF v IS NULL THEN RETURN ROW(0, false)::lms.score_result; END IF;
    tol := coalesce((p_key ->> 'tolerance')::numeric, 0);
    IF coalesce(p_key ->> 'mode', 'absolute') = 'percent' THEN tol := abs((p_key ->> 'value')::numeric) * tol / 100; END IF;
    RETURN ROW(CASE WHEN abs(v - (p_key ->> 'value')::numeric) <= tol + 0.000000001 THEN p_points ELSE 0 END, false)::lms.score_result;
  ELSIF p_type = 'short_answer' THEN
    txt := lms.norm_text(p_answer ->> 't');
    IF txt = '' THEN RETURN ROW(0, false)::lms.score_result; END IF;
    IF coalesce(p_key ->> 'mode', 'auto') = 'manual' THEN RETURN ROW(0, true)::lms.score_result; END IF;
    RETURN ROW(CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_key -> 'accepted') a WHERE lms.norm_text(a) = txt)
                    THEN p_points ELSE 0 END, false)::lms.score_result;
  ELSE -- essay: a person grades it (an empty essay is a plain zero)
    RETURN ROW(0, btrim(coalesce(p_answer ->> 't', '')) <> '')::lms.score_result;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION lms.norm_text(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.score_answer(text, jsonb, jsonb, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.norm_text(text) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.score_answer(text, jsonb, jsonb, numeric) TO lms_app;

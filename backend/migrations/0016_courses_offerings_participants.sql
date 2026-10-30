-- Step 6: courses (the catalog entry of a college), offerings (one run of a course in a term), the
-- sections an offering is for, and who participates (instructor / assistant / learner).
-- Every table is tenant-scoped with forced RLS and composite foreign keys that include tenant_id.

CREATE TYPE lms.offering_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE lms.participation_type AS ENUM ('instructor', 'assistant', 'learner');
CREATE TYPE lms.participant_source AS ENUM ('manual', 'section');
CREATE TYPE lms.participant_status AS ENUM ('active', 'removed');

-- ------------------------------------------------------------------ courses
CREATE TABLE lms.courses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  credits numeric(4, 1) CHECK (credits >= 0 AND credits <= 99),
  -- OPTIONAL: colleges run cross-department electives, value-added and skill courses
  department_id uuid,
  -- 'tenant' = created in this college. 'platform_copy' is RESERVED for a future JCS platform catalog
  -- whose courses are copied into a college when licensed (source_ref then names the catalog entry).
  origin text NOT NULL DEFAULT 'tenant' CHECK (origin IN ('tenant', 'platform_copy')),
  source_ref text CHECK (length(source_ref) <= 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT courses_code_key UNIQUE (tenant_id, code),
  CONSTRAINT courses_origin_ref CHECK ((origin = 'tenant') = (source_ref IS NULL)),
  -- MATCH SIMPLE: not checked while department_id IS NULL
  CONSTRAINT courses_department_fk FOREIGN KEY (tenant_id, department_id)
    REFERENCES lms.departments (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX courses_department_idx ON lms.courses (tenant_id, department_id, id);
CREATE INDEX courses_list_idx ON lms.courses (tenant_id, id) WHERE archived_at IS NULL;

-- ------------------------------------------------------------------ offerings
CREATE TABLE lms.course_offerings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  course_id uuid NOT NULL,
  term_id uuid NOT NULL,
  -- tells apart two runs of the same course in one term ("Section X evening batch"); '' = the only run
  label text NOT NULL DEFAULT '' CHECK (label = btrim(label) AND length(label) <= 40),
  title_override text CHECK (title_override = btrim(title_override) AND length(title_override) BETWEEN 1 AND 200),
  status lms.offering_status NOT NULL DEFAULT 'draft',
  -- a copy of another offering's content runs in the background when it is large
  copy_status text NOT NULL DEFAULT 'none' CHECK (copy_status IN ('none', 'running', 'done', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_offerings_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT course_offerings_run_key UNIQUE (tenant_id, course_id, term_id, label),
  CONSTRAINT course_offerings_course_fk FOREIGN KEY (tenant_id, course_id)
    REFERENCES lms.courses (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_term_fk FOREIGN KEY (tenant_id, term_id)
    REFERENCES lms.terms (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX course_offerings_term_idx ON lms.course_offerings (tenant_id, term_id, id);
CREATE INDEX course_offerings_course_idx ON lms.course_offerings (tenant_id, course_id, id);

-- A course cannot be archived while it still has offerings that are not archived (409, no cascade).
CREATE FUNCTION lms.course_archive_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND EXISTS (
       SELECT 1 FROM lms.course_offerings o
        WHERE o.tenant_id = NEW.tenant_id AND o.course_id = NEW.id AND o.status <> 'archived') THEN
    RAISE EXCEPTION 'the course still has offerings' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'archive_has_active_children';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.course_archive_guard() FROM PUBLIC;
CREATE TRIGGER courses_archive_guard BEFORE UPDATE OF archived_at ON lms.courses
  FOR EACH ROW EXECUTE FUNCTION lms.course_archive_guard();

-- An offering cannot be created for an archived course or term.
CREATE FUNCTION lms.offering_parent_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (
       EXISTS (SELECT 1 FROM lms.courses c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.course_id
                 AND c.archived_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM lms.terms t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.term_id
                 AND t.archived_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'the course or the term is archived' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'parent_archived';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.offering_parent_guard() FROM PUBLIC;
CREATE TRIGGER course_offerings_parent_guard BEFORE INSERT ON lms.course_offerings
  FOR EACH ROW EXECUTE FUNCTION lms.offering_parent_guard();

-- ------------------------------------------------------------------ sections of an offering
CREATE TABLE lms.offering_sections (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  section_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offering_id, section_id),
  CONSTRAINT offering_sections_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT offering_sections_section_fk FOREIGN KEY (tenant_id, section_id)
    REFERENCES lms.sections (tenant_id, id) ON DELETE RESTRICT
);
-- the enrolment sync joins a student's section to the offerings it is enrolled in
CREATE INDEX offering_sections_section_idx ON lms.offering_sections (tenant_id, section_id, offering_id);

-- ------------------------------------------------------------------ participants
CREATE TABLE lms.course_participants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  participation lms.participation_type NOT NULL,
  -- 'manual': added by an administrator, never touched by the section sync.
  -- 'section': enrolled because the student is in an enrolled section (always a learner).
  source lms.participant_source NOT NULL DEFAULT 'manual',
  -- which section brought a section-sourced learner (kept for history, not a foreign key: removing a
  -- section from an offering keeps the removed rows)
  source_section_id uuid,
  status lms.participant_status NOT NULL DEFAULT 'active',
  -- 'manual': an administrator removed them (sticky: the sync never re-adds them);
  -- 'sync': they left the section or were suspended (the sync re-adds them when they return)
  removed_reason text CHECK (removed_reason IN ('manual', 'sync')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_participants_one_key UNIQUE (tenant_id, offering_id, membership_id),
  CONSTRAINT course_participants_source_ck CHECK (
    (source = 'section') = (source_section_id IS NOT NULL) AND (source <> 'section' OR participation = 'learner')),
  CONSTRAINT course_participants_removed_ck CHECK ((status = 'removed') = (removed_reason IS NOT NULL)),
  CONSTRAINT course_participants_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  -- removing a member from the college removes their participations with them
  CONSTRAINT course_participants_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE CASCADE
);
-- the class list (keyset on id)
CREATE INDEX course_participants_list_idx ON lms.course_participants (tenant_id, offering_id, id);
-- "my courses" and the participation lookup of one member
CREATE INDEX course_participants_member_idx ON lms.course_participants (tenant_id, membership_id, offering_id)
  WHERE status = 'active';
-- removing a section from an offering finds the learners it brought
CREATE INDEX course_participants_section_idx ON lms.course_participants (tenant_id, offering_id, source_section_id)
  WHERE source = 'section';

-- ------------------------------------------------------------------ incremental enrolment sync
-- Triggers record WHICH members changed (membership id only, deduplicated by the primary key), in the same
-- transaction as the change, and make sure a sync job is QUEUED for the tenant. The job takes the rows in
-- bounded batches and deletes them in the transaction that applies them: its cost follows the number of
-- changes, not the size of the college.
CREATE TABLE lms.course_sync_pending (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  membership_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, membership_id)
);

-- marks the members and queues ONE job per tenant. A job that is already RUNNING does not suppress the
-- new one (only a queued job does): a change made while a sync runs is picked up by that run's next batch
-- or by the job queued here, and the sync is idempotent, so an extra run is harmless.
CREATE FUNCTION lms.course_sync_mark(p_tenants uuid[], p_memberships uuid[])
RETURNS void
LANGUAGE sql SET search_path = lms, pg_temp
AS $$
  WITH changed AS (
    SELECT DISTINCT t.tenant_id, t.membership_id FROM unnest(p_tenants, p_memberships) AS t(tenant_id, membership_id)
  ), marked AS (
    INSERT INTO lms.course_sync_pending (tenant_id, membership_id)
    SELECT tenant_id, membership_id FROM changed
    ON CONFLICT DO NOTHING
  )
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
  SELECT gen_random_uuid(), 'courses.sync', c.tenant_id, '{}'::jsonb, 5
    FROM (SELECT DISTINCT tenant_id FROM changed) c
   WHERE NOT EXISTS (SELECT 1 FROM lms.jobs j
                      WHERE j.tenant_id = c.tenant_id AND j.queue = 'courses.sync' AND j.status = 'queued')
$$;
REVOKE ALL ON FUNCTION lms.course_sync_mark(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.course_sync_mark(uuid[], uuid[]) TO lms_app;

CREATE FUNCTION lms.course_sync_on_profile_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM lms.course_sync_mark(array_agg(tenant_id), array_agg(membership_id))
     FROM new_rows WHERE section_id IS NOT NULL;
  RETURN NULL;
END
$$;
CREATE FUNCTION lms.course_sync_on_profile_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM lms.course_sync_mark(array_agg(n.tenant_id), array_agg(n.membership_id))
     FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE n.section_id IS DISTINCT FROM o.section_id OR n.profile_type IS DISTINCT FROM o.profile_type;
  RETURN NULL;
END
$$;
CREATE FUNCTION lms.course_sync_on_membership_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM lms.course_sync_mark(array_agg(n.tenant_id), array_agg(n.id))
     FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.status IS DISTINCT FROM o.status;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.course_sync_on_profile_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.course_sync_on_profile_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.course_sync_on_membership_update() FROM PUBLIC;

-- statement-level with transition tables: a bulk move or an import batch is ONE call, not one per row
CREATE TRIGGER member_profiles_course_sync_ins AFTER INSERT ON lms.member_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.course_sync_on_profile_insert();
CREATE TRIGGER member_profiles_course_sync_upd AFTER UPDATE ON lms.member_profiles
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION lms.course_sync_on_profile_update();
CREATE TRIGGER tenant_memberships_course_sync_upd AFTER UPDATE ON lms.tenant_memberships
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION lms.course_sync_on_membership_update();

-- ------------------------------------------------------------------ RLS, owner policies, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['courses', 'course_offerings', 'offering_sections', 'course_participants', 'course_sync_pending']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON lms.%I FOR ALL TO lms_app USING (tenant_id = (SELECT lms.current_tenant_id())) '
      || 'WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))', t || '_all', t);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON lms.courses, lms.course_offerings, lms.course_participants TO lms_app;
GRANT UPDATE (title, description, credits, department_id, archived_at, updated_at) ON lms.courses TO lms_app;
GRANT UPDATE (label, title_override, status, copy_status, updated_at) ON lms.course_offerings TO lms_app;
GRANT UPDATE (participation, source, source_section_id, status, removed_reason, updated_at)
  ON lms.course_participants TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.offering_sections TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.course_sync_pending TO lms_app;

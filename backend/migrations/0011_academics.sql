-- Step 5: academic structure (how an Indian college is organised), all tenant-scoped with forced RLS.
--   academic_years -> terms;   departments -> programs -> batches -> sections
-- Rules live in the database: one current year per tenant, no overlapping terms within a year, unique
-- codes, immutable parents, archive refusals while active children exist, and nothing that history
-- depends on can be hard-deleted (ON DELETE RESTRICT everywhere).

-- Exclusion constraint on "same tenant + same year + overlapping dates" needs equality on uuid inside a
-- GiST index: that is what btree_gist provides (available on Supabase and Cloud SQL).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- academic_years
CREATE TABLE lms.academic_years (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  label text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 32),
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_years_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT academic_years_label_key UNIQUE (tenant_id, label),
  CONSTRAINT academic_years_dates_check CHECK (start_date < end_date),
  CONSTRAINT academic_years_current_not_archived CHECK (NOT (is_current AND archived_at IS NOT NULL)),
  -- at most ONE current year per tenant. DEFERRABLE (checked at the end of the statement) so that
  -- "set current" can swap the flag between two rows in a single UPDATE
  CONSTRAINT academic_years_one_current EXCLUDE USING btree (tenant_id WITH =) WHERE (is_current)
    DEFERRABLE INITIALLY IMMEDIATE
);

-- ---------------------------------------------------------------- terms
CREATE TABLE lms.terms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  academic_year_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  start_date date NOT NULL,
  end_date date NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terms_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT terms_name_key UNIQUE (tenant_id, academic_year_id, name),
  CONSTRAINT terms_dates_check CHECK (start_date < end_date),
  CONSTRAINT terms_year_fk FOREIGN KEY (tenant_id, academic_year_id)
    REFERENCES lms.academic_years (tenant_id, id) ON DELETE RESTRICT,
  -- terms of one year never overlap (archived terms are out of the way)
  CONSTRAINT terms_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, academic_year_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (archived_at IS NULL)
);
CREATE INDEX terms_year_idx ON lms.terms (tenant_id, academic_year_id, id);

-- ---------------------------------------------------------------- departments
CREATE TABLE lms.departments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT departments_code_key UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------- programs
CREATE TABLE lms.programs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  department_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  duration_years smallint NOT NULL CHECK (duration_years BETWEEN 1 AND 8),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT programs_code_key UNIQUE (tenant_id, code),
  CONSTRAINT programs_department_fk FOREIGN KEY (tenant_id, department_id)
    REFERENCES lms.departments (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX programs_department_idx ON lms.programs (tenant_id, department_id, id);

-- ---------------------------------------------------------------- batches
CREATE TABLE lms.batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  program_id uuid NOT NULL,
  admission_year smallint NOT NULL CHECK (admission_year BETWEEN 1950 AND 2200),
  graduation_year smallint NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batches_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT batches_year_key UNIQUE (tenant_id, program_id, admission_year),
  CONSTRAINT batches_years_check CHECK (graduation_year > admission_year AND graduation_year <= 2210),
  CONSTRAINT batches_program_fk FOREIGN KEY (tenant_id, program_id)
    REFERENCES lms.programs (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX batches_program_idx ON lms.batches (tenant_id, program_id, id);

-- ---------------------------------------------------------------- sections
CREATE TABLE lms.sections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  batch_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,9}$'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sections_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT sections_code_key UNIQUE (tenant_id, batch_id, code),
  -- target of the composite FK from member_profiles: a student's section must belong to their batch
  CONSTRAINT sections_tenant_batch_id_key UNIQUE (tenant_id, batch_id, id),
  CONSTRAINT sections_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES lms.batches (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sections_batch_idx ON lms.sections (tenant_id, batch_id, id);

-- ---------------------------------------------------------------- invariants as triggers
-- Parents are immutable: re-parenting would silently rewrite history (archive and recreate instead).
CREATE FUNCTION lms.guard_immutable_parent()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0] THEN
    RAISE EXCEPTION '% of a % cannot be changed', TG_ARGV[0], TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = 'immutable_parent';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_immutable_parent() FROM PUBLIC;
CREATE TRIGGER terms_immutable_parent BEFORE UPDATE ON lms.terms
  FOR EACH ROW EXECUTE FUNCTION lms.guard_immutable_parent('academic_year_id');
CREATE TRIGGER programs_immutable_parent BEFORE UPDATE ON lms.programs
  FOR EACH ROW EXECUTE FUNCTION lms.guard_immutable_parent('department_id');
CREATE TRIGGER batches_immutable_parent BEFORE UPDATE ON lms.batches
  FOR EACH ROW EXECUTE FUNCTION lms.guard_immutable_parent('program_id');
CREATE TRIGGER sections_immutable_parent BEFORE UPDATE ON lms.sections
  FOR EACH ROW EXECUTE FUNCTION lms.guard_immutable_parent('batch_id');
CREATE TRIGGER batches_immutable_years BEFORE UPDATE ON lms.batches
  FOR EACH ROW EXECUTE FUNCTION lms.guard_immutable_parent('admission_year');

-- Archiving is refused while ACTIVE children exist (no cascade).
CREATE FUNCTION lms.guard_archive_children()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  v_busy boolean;
BEGIN
  IF NEW.archived_at IS NULL OR OLD.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'departments' THEN
    SELECT EXISTS (SELECT 1 FROM lms.programs c WHERE c.tenant_id = OLD.tenant_id
                   AND c.department_id = OLD.id AND c.archived_at IS NULL) INTO v_busy;
  ELSIF TG_TABLE_NAME = 'programs' THEN
    SELECT EXISTS (SELECT 1 FROM lms.batches c WHERE c.tenant_id = OLD.tenant_id
                   AND c.program_id = OLD.id AND c.archived_at IS NULL) INTO v_busy;
  ELSIF TG_TABLE_NAME = 'batches' THEN
    SELECT EXISTS (SELECT 1 FROM lms.sections c WHERE c.tenant_id = OLD.tenant_id
                   AND c.batch_id = OLD.id AND c.archived_at IS NULL) INTO v_busy;
  ELSIF TG_TABLE_NAME = 'academic_years' THEN
    SELECT EXISTS (SELECT 1 FROM lms.terms c WHERE c.tenant_id = OLD.tenant_id
                   AND c.academic_year_id = OLD.id AND c.archived_at IS NULL) INTO v_busy;
  END IF;
  IF v_busy THEN
    RAISE EXCEPTION 'cannot archive a % that still has active children', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = 'archive_has_active_children';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_archive_children() FROM PUBLIC;
CREATE TRIGGER departments_archive_guard BEFORE UPDATE OF archived_at ON lms.departments
  FOR EACH ROW EXECUTE FUNCTION lms.guard_archive_children();
CREATE TRIGGER programs_archive_guard BEFORE UPDATE OF archived_at ON lms.programs
  FOR EACH ROW EXECUTE FUNCTION lms.guard_archive_children();
CREATE TRIGGER batches_archive_guard BEFORE UPDATE OF archived_at ON lms.batches
  FOR EACH ROW EXECUTE FUNCTION lms.guard_archive_children();
CREATE TRIGGER academic_years_archive_guard BEFORE UPDATE OF archived_at ON lms.academic_years
  FOR EACH ROW EXECUTE FUNCTION lms.guard_archive_children();

-- A child can only be created / unarchived under an ACTIVE parent. The parent row is locked FOR SHARE
-- so a concurrent archive of the parent waits for this statement.
CREATE FUNCTION lms.guard_parent_active()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  v_archived timestamptz;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'terms' THEN
    SELECT p.archived_at INTO v_archived FROM lms.academic_years p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.academic_year_id FOR SHARE;
  ELSIF TG_TABLE_NAME = 'programs' THEN
    SELECT p.archived_at INTO v_archived FROM lms.departments p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.department_id FOR SHARE;
  ELSIF TG_TABLE_NAME = 'batches' THEN
    SELECT p.archived_at INTO v_archived FROM lms.programs p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.program_id FOR SHARE;
  ELSIF TG_TABLE_NAME = 'sections' THEN
    SELECT p.archived_at INTO v_archived FROM lms.batches p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.batch_id FOR SHARE;
  END IF;
  IF FOUND AND v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'the parent of this % is archived', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = 'parent_archived';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_parent_active() FROM PUBLIC;
CREATE TRIGGER terms_parent_active BEFORE INSERT OR UPDATE OF archived_at ON lms.terms
  FOR EACH ROW EXECUTE FUNCTION lms.guard_parent_active();
CREATE TRIGGER programs_parent_active BEFORE INSERT OR UPDATE OF archived_at ON lms.programs
  FOR EACH ROW EXECUTE FUNCTION lms.guard_parent_active();
CREATE TRIGGER batches_parent_active BEFORE INSERT OR UPDATE OF archived_at ON lms.batches
  FOR EACH ROW EXECUTE FUNCTION lms.guard_parent_active();
CREATE TRIGGER sections_parent_active BEFORE INSERT OR UPDATE OF archived_at ON lms.sections
  FOR EACH ROW EXECUTE FUNCTION lms.guard_parent_active();

-- A term lies inside its academic year; a year's dates cannot move away from its (active) terms.
CREATE FUNCTION lms.guard_term_in_year()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'terms' THEN
    IF NOT EXISTS (
      SELECT 1 FROM lms.academic_years y
       WHERE y.tenant_id = NEW.tenant_id AND y.id = NEW.academic_year_id
         AND NEW.start_date >= y.start_date AND NEW.end_date <= y.end_date
    ) THEN
      RAISE EXCEPTION 'a term must lie within its academic year'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_within_year';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM lms.terms t
       WHERE t.tenant_id = NEW.tenant_id AND t.academic_year_id = NEW.id AND t.archived_at IS NULL
         AND (t.start_date < NEW.start_date OR t.end_date > NEW.end_date)
    ) THEN
      RAISE EXCEPTION 'the academic year would no longer contain its terms'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_within_year';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_term_in_year() FROM PUBLIC;
CREATE TRIGGER terms_in_year BEFORE INSERT OR UPDATE OF start_date, end_date ON lms.terms
  FOR EACH ROW EXECUTE FUNCTION lms.guard_term_in_year();
CREATE TRIGGER academic_years_keep_terms BEFORE UPDATE OF start_date, end_date ON lms.academic_years
  FOR EACH ROW EXECUTE FUNCTION lms.guard_term_in_year();

-- ---------------------------------------------------------------- RLS, policies, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['academic_years', 'terms', 'departments', 'programs', 'batches', 'sections'] LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON lms.%I FOR ALL TO lms_app
         USING (tenant_id = (SELECT lms.current_tenant_id()))
         WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))',
      t || '_all', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    ) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
                     t, current_user);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, DELETE ON lms.academic_years, lms.terms, lms.departments, lms.programs,
  lms.batches, lms.sections TO lms_app;
-- parents (department_id, program_id, batch_id, academic_year_id) are not updatable
GRANT UPDATE (label, start_date, end_date, is_current, archived_at, updated_at) ON lms.academic_years TO lms_app;
GRANT UPDATE (name, start_date, end_date, archived_at, updated_at) ON lms.terms TO lms_app;
GRANT UPDATE (code, name, archived_at, updated_at) ON lms.departments TO lms_app;
GRANT UPDATE (code, name, duration_years, archived_at, updated_at) ON lms.programs TO lms_app;
GRANT UPDATE (graduation_year, archived_at, updated_at) ON lms.batches TO lms_app;
GRANT UPDATE (code, archived_at, updated_at) ON lms.sections TO lms_app;

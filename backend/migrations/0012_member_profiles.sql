-- Step 5: member profiles. One per membership (tenant-scoped). profile_type is a LABEL for display,
-- filtering and reports: it grants NO permission (permissions come only from the account role and
-- course participation).
--   student:        register_number, batch_id, section_id (+ department_id, derived from the batch)
--   faculty/staff:  employee_id, department_id

CREATE TYPE lms.profile_type AS ENUM ('student', 'faculty', 'staff');

CREATE TABLE lms.member_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  membership_id uuid NOT NULL,
  profile_type lms.profile_type NOT NULL,
  phone text CHECK (phone ~ '^\+?[0-9][0-9 -]{5,18}$'),
  designation text CHECK (designation = btrim(designation) AND length(designation) BETWEEN 1 AND 100),
  register_number text CHECK (register_number ~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$'),
  employee_id text CHECK (employee_id ~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$'),
  batch_id uuid,
  section_id uuid,
  department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_profiles_membership_key UNIQUE (tenant_id, membership_id),
  CONSTRAINT member_profiles_register_key UNIQUE (tenant_id, register_number),
  CONSTRAINT member_profiles_employee_key UNIQUE (tenant_id, employee_id),
  -- deleting a membership removes its profile
  CONSTRAINT member_profiles_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_profiles_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES lms.batches (tenant_id, id) ON DELETE RESTRICT,
  -- a student's section must belong to THEIR batch (MATCH SIMPLE skips the check when a column is
  -- NULL, hence the CHECK below)
  CONSTRAINT member_profiles_section_fk FOREIGN KEY (tenant_id, batch_id, section_id)
    REFERENCES lms.sections (tenant_id, batch_id, id) ON DELETE RESTRICT,
  CONSTRAINT member_profiles_department_fk FOREIGN KEY (tenant_id, department_id)
    REFERENCES lms.departments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT member_profiles_section_needs_batch CHECK (section_id IS NULL OR batch_id IS NOT NULL),
  CONSTRAINT member_profiles_type_fields CHECK (
    (profile_type = 'student' AND employee_id IS NULL)
    OR (profile_type <> 'student' AND register_number IS NULL AND batch_id IS NULL AND section_id IS NULL)
  )
);

-- member list filters: every index leads with tenant_id and ends with membership_id, so a filtered
-- page keeps the keyset order of GET /members
CREATE INDEX member_profiles_section_idx ON lms.member_profiles (tenant_id, section_id, membership_id)
  WHERE section_id IS NOT NULL;
CREATE INDEX member_profiles_batch_idx ON lms.member_profiles (tenant_id, batch_id, membership_id)
  WHERE batch_id IS NOT NULL;
CREATE INDEX member_profiles_department_idx ON lms.member_profiles (tenant_id, department_id, membership_id)
  WHERE department_id IS NOT NULL;
CREATE INDEX member_profiles_type_idx ON lms.member_profiles (tenant_id, profile_type, membership_id);

-- A student's department is derived from their batch (batch -> program -> department), and nobody can
-- be put into an archived batch or section.
CREATE FUNCTION lms.member_profile_derive()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NEW.profile_type = 'student' THEN
    NEW.department_id := (
      SELECT pr.department_id FROM lms.batches b
        JOIN lms.programs pr ON pr.tenant_id = b.tenant_id AND pr.id = b.program_id
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id);
  END IF;
  IF NEW.batch_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.batch_id IS DISTINCT FROM OLD.batch_id)
     AND EXISTS (SELECT 1 FROM lms.batches b WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
                   AND b.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the batch is archived' USING ERRCODE = 'check_violation', CONSTRAINT = 'parent_archived';
  END IF;
  IF NEW.section_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.section_id IS DISTINCT FROM OLD.section_id)
     AND EXISTS (SELECT 1 FROM lms.sections s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.section_id
                   AND s.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the section is archived' USING ERRCODE = 'check_violation', CONSTRAINT = 'parent_archived';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.member_profile_derive() FROM PUBLIC;
CREATE TRIGGER member_profiles_derive BEFORE INSERT OR UPDATE ON lms.member_profiles
  FOR EACH ROW EXECUTE FUNCTION lms.member_profile_derive();

ALTER TABLE lms.member_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.member_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY member_profiles_all ON lms.member_profiles FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.member_profiles FOR ALL TO %I USING (true) WITH CHECK (true)',
                   current_user);
  END IF;
END
$$;

-- no DELETE for lms_app: a profile goes away with its membership (the FK cascade)
GRANT SELECT, INSERT ON lms.member_profiles TO lms_app;
GRANT UPDATE (profile_type, phone, designation, register_number, employee_id, batch_id, section_id,
              department_id, updated_at) ON lms.member_profiles TO lms_app;

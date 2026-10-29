-- Step 5: bulk CSV import. A file is parsed into a tenant-scoped STAGING table (import_rows), validated
-- there with set-based SQL (a dry run: nothing touches the real tables), and only after the admin
-- confirms is it applied by a background job in batches of rows.

CREATE TYPE lms.import_kind AS ENUM ('students', 'faculty');
CREATE TYPE lms.import_status AS ENUM (
  'parsing', 'validated', 'failed', 'queued', 'processing', 'completed', 'completed_with_errors', 'cancelled'
);
CREATE TYPE lms.import_row_status AS ENUM ('pending', 'valid', 'invalid', 'processed', 'skipped', 'failed');

CREATE TABLE lms.import_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  kind lms.import_kind NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  status lms.import_status NOT NULL DEFAULT 'parsing',
  -- chosen at confirm time
  update_existing boolean NOT NULL DEFAULT false,
  skip_invalid boolean NOT NULL DEFAULT false,
  -- counts are RECOMPUTED from import_rows after every batch (never accumulated), so a crash and
  -- resume cannot leave them wrong
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  skipped_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  created_members integer NOT NULL DEFAULT 0,
  updated_members integer NOT NULL DEFAULT 0,
  error text,
  created_by_user_id uuid NOT NULL REFERENCES lms.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- the staged rows (names, emails) are deleted after the retention period; this summary stays
  rows_purged_at timestamptz,
  CONSTRAINT import_jobs_tenant_id_id_key UNIQUE (tenant_id, id)
);
-- ONE running import per tenant, enforced by the database: a confirmed (queued) or processing import
-- blocks the next confirm (unique violation -> 409 import_in_progress)
CREATE UNIQUE INDEX import_jobs_one_running ON lms.import_jobs (tenant_id)
  WHERE status IN ('queued', 'processing');
CREATE INDEX import_jobs_list_idx ON lms.import_jobs (tenant_id, id);
CREATE INDEX import_jobs_purge_idx ON lms.import_jobs (status, updated_at) WHERE rows_purged_at IS NULL;

CREATE TABLE lms.import_rows (
  tenant_id uuid NOT NULL,
  import_id uuid NOT NULL,
  -- spreadsheet row number: the header is row 1, the first data row is row 2
  row_number integer NOT NULL,
  status lms.import_row_status NOT NULL DEFAULT 'pending',
  raw jsonb NOT NULL,
  email text,
  full_name text,
  register_number text,
  employee_id text,
  department_code text,
  program_code text,
  batch_label text,
  section_code text,
  phone text,
  -- resolved by the validation pass
  department_id uuid,
  program_id uuid,
  batch_id uuid,
  section_id uuid,
  -- [{ "column": "email", "message": "..." }]
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  result text,
  PRIMARY KEY (tenant_id, import_id, row_number),
  CONSTRAINT import_rows_import_fk FOREIGN KEY (tenant_id, import_id)
    REFERENCES lms.import_jobs (tenant_id, id) ON DELETE CASCADE
);
-- the next batch to process: valid rows in order
CREATE INDEX import_rows_status_idx ON lms.import_rows (tenant_id, import_id, status, row_number);

ALTER TABLE lms.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.import_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_jobs_all ON lms.import_jobs FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));
CREATE POLICY import_rows_all ON lms.import_rows FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    FOREACH t IN ARRAY ARRAY['import_jobs', 'import_rows'] LOOP
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
                     t, current_user);
    END LOOP;
  END IF;
END
$$;

-- no DELETE for lms_app: staged rows are removed by the bounded purge function below
GRANT SELECT, INSERT, UPDATE ON lms.import_jobs, lms.import_rows TO lms_app;

-- ---------------------------------------------------------------- users for a batch of rows
-- lms_app cannot INSERT into users, so a batch of NEW accounts is created here, set-based. It is bound to
-- the staged rows of ONE import of the caller's tenant: only emails that appear there (as valid rows) are
-- touched, and ids come from the application (UUIDv7, one per row of the batch, in row order).
-- Returns, for every such email, the user id and whether this call created the account.
CREATE FUNCTION lms.import_ensure_users(
  p_tenant_id uuid, p_import_id uuid, p_ids uuid[], p_emails text[], p_names text[]
)
RETURNS TABLE (r_email text, r_user_id uuid, r_created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM lms.current_tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO lms.users AS u (id, email, display_name)
  SELECT x.id, lower(btrim(x.email)), left(btrim(x.name), 200)
    FROM unnest(p_ids, p_emails, p_names) AS x(id, email, name)
   WHERE EXISTS (
     SELECT 1 FROM lms.import_rows r
      WHERE r.tenant_id = p_tenant_id AND r.import_id = p_import_id
        AND r.status = 'valid' AND r.email = lower(btrim(x.email)))
  ON CONFLICT (email) DO NOTHING;
  RETURN QUERY
    SELECT x.email, u.id, (u.id = x.id)
      FROM unnest(p_ids, p_emails) AS x(id, email)
      JOIN lms.users u ON u.email = lower(btrim(x.email))
     WHERE EXISTS (
       SELECT 1 FROM lms.import_rows r
        WHERE r.tenant_id = p_tenant_id AND r.import_id = p_import_id
          AND r.status = 'valid' AND r.email = lower(btrim(x.email)));
END
$$;

-- ---------------------------------------------------------------- retention of staged rows (PII)
-- Deletes at most p_batch staged rows of imports that are finished, failed, cancelled or abandoned
-- (validated but never confirmed) for more than p_retention_days; the import_jobs summary row stays.
-- Returns the number of rows deleted.
CREATE FUNCTION lms.import_purge_rows(p_retention_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- an abandoned draft is closed first so it cannot be confirmed after its rows are gone
  UPDATE lms.import_jobs j SET status = 'cancelled', updated_at = now(), finished_at = now()
   WHERE j.status = 'validated' AND j.rows_purged_at IS NULL
     AND j.updated_at < now() - make_interval(days => p_retention_days);

  WITH victims AS (
    SELECT j.tenant_id, j.id FROM lms.import_jobs j
     WHERE j.rows_purged_at IS NULL
       AND j.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
       AND COALESCE(j.finished_at, j.updated_at) < now() - make_interval(days => p_retention_days)
     LIMIT 100
  ), doomed AS (
    SELECT r.tenant_id, r.import_id, r.row_number FROM lms.import_rows r
      JOIN victims v ON v.tenant_id = r.tenant_id AND v.id = r.import_id
     LIMIT LEAST(GREATEST(p_batch, 1), 10000)
  )
  DELETE FROM lms.import_rows r USING doomed d
   WHERE r.tenant_id = d.tenant_id AND r.import_id = d.import_id AND r.row_number = d.row_number;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE lms.import_jobs j SET rows_purged_at = now()
   WHERE j.rows_purged_at IS NULL
     AND j.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
     AND COALESCE(j.finished_at, j.updated_at) < now() - make_interval(days => p_retention_days)
     AND NOT EXISTS (SELECT 1 FROM lms.import_rows r WHERE r.tenant_id = j.tenant_id AND r.import_id = j.id);
  RETURN v_n;
END
$$;

-- ---------------------------------------------------------------- an import whose job died
-- If the queue gave up on an import's job (dead letter: every attempt failed or its lease expired after
-- the last one) the import would stay 'queued' / 'processing' forever and block the tenant's next import
-- (one running import per tenant). Marks those imports failed; returns how many.
CREATE FUNCTION lms.import_reap_dead()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.import_jobs j
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error = COALESCE(j.error, 'the background job gave up (see the job log)')
   WHERE j.status IN ('queued', 'processing')
     AND EXISTS (
       SELECT 1 FROM lms.jobs q
        WHERE q.queue = 'imports.process' AND q.status = 'dead' AND q.tenant_id = j.tenant_id
          AND q.payload ->> 'importId' = j.id::text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'import\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

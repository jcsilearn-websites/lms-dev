-- Step 6: metadata of uploaded files. The bytes live in object storage (a local directory in development,
-- Google Cloud Storage later); this table is the authority on who may read them.
-- Purge functions (they need content_items) come with migration 0018.

CREATE TABLE lms.files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  -- storage object name: <tenant>/<file id>, built by the server, never from user input
  storage_key text NOT NULL CHECK (length(storage_key) <= 200),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  -- the type the SERVER decided on (allowlist + magic bytes), not what the browser claimed
  content_type text NOT NULL CHECK (length(content_type) <= 100),
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  size_bytes bigint CHECK (size_bytes > 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- pending: upload URL issued; ready: bytes verified by the confirm step
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  -- the last time something stopped referencing the file; the purge grace period starts at the later of
  -- confirmed_at and this (a copy of content shares the row, so a reference can come and go)
  last_unreferenced_at timestamptz,
  CONSTRAINT files_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT files_storage_key_key UNIQUE (storage_key),
  CONSTRAINT files_ready_ck CHECK ((status = 'ready') = (confirmed_at IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL))
);
-- the purge scans by age
CREATE INDEX files_purge_idx ON lms.files (created_at, id);

ALTER TABLE lms.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_all ON lms.files FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.files FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;

-- no DELETE for lms_app: only the purge definer function removes rows
GRANT SELECT, INSERT ON lms.files TO lms_app;
GRANT UPDATE (size_bytes, sha256, content_type, status, confirmed_at, last_unreferenced_at) ON lms.files TO lms_app;

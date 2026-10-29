-- Core identity + tenancy tables with Row-Level Security.
-- Tenant context comes from the transaction-local setting app.tenant_id (set by withTenant()).
-- With no tenant set, current_tenant_id() is NULL and every policy evaluates to no rows.

CREATE TYPE lms.membership_role AS ENUM ('institution_admin', 'member');

CREATE FUNCTION lms.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION lms.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- tenants
CREATE TABLE lms.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users (global identity)
CREATE TABLE lms.users (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON lms.users (email);

-- ---------------------------------------------------------------- tenant_memberships
CREATE TABLE lms.tenant_memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  user_id uuid NOT NULL REFERENCES lms.users (id),
  role lms.membership_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_memberships_tenant_user_key UNIQUE (tenant_id, user_id),
  -- target of composite foreign keys from other tenant-owned tables
  CONSTRAINT tenant_memberships_tenant_id_id_key UNIQUE (tenant_id, id)
);
CREATE INDEX tenant_memberships_user_id_idx ON lms.tenant_memberships (user_id);

-- ---------------------------------------------------------------- audit_log (append-only)
CREATE TABLE lms.audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  -- NULL actor = system/worker
  actor_user_id uuid REFERENCES lms.users (id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON lms.audit_log (tenant_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------- tenant_settings (RLS example)
CREATE TABLE lms.tenant_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
  value jsonb NOT NULL,
  updated_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_settings_tenant_key_key UNIQUE (tenant_id, key),
  -- composite FK: the referenced membership must belong to the SAME tenant
  CONSTRAINT tenant_settings_updated_by_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE SET NULL (updated_by_membership_id)
);

-- ---------------------------------------------------------------- RLS
ALTER TABLE lms.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.users FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.tenant_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_select ON lms.tenants FOR SELECT TO lms_app
  USING (id = (SELECT lms.current_tenant_id()));

-- A user is visible only through a membership in the current tenant, or as the current user.
CREATE POLICY users_select ON lms.users FOR SELECT TO lms_app
  USING (
    id = (SELECT lms.current_user_id())
    OR EXISTS (
      SELECT 1 FROM lms.tenant_memberships m
      WHERE m.user_id = users.id AND m.tenant_id = (SELECT lms.current_tenant_id())
    )
  );

CREATE POLICY tenant_memberships_all ON lms.tenant_memberships FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

CREATE POLICY audit_log_select ON lms.audit_log FOR SELECT TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()));
CREATE POLICY audit_log_insert ON lms.audit_log FOR INSERT TO lms_app
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

CREATE POLICY tenant_settings_all ON lms.tenant_settings FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

-- The migration/owner role must be able to seed and administer. Superusers and BYPASSRLS roles
-- skip RLS anyway; on managed Postgres where the owner is neither, give it explicit policies.
-- (lms_app never gets these.)
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    FOREACH t IN ARRAY ARRAY['tenants', 'users', 'tenant_memberships', 'audit_log', 'tenant_settings'] LOOP
      EXECUTE format(
        'CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
        t, current_user
      );
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------- grants (least privilege)
GRANT SELECT ON lms.tenants TO lms_app;
GRANT SELECT ON lms.users TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.tenant_memberships TO lms_app;
GRANT UPDATE (role, updated_at) ON lms.tenant_memberships TO lms_app;
-- append-only: no UPDATE / DELETE / TRUNCATE
GRANT SELECT, INSERT ON lms.audit_log TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.tenant_settings TO lms_app;
GRANT UPDATE (value, updated_by_membership_id, updated_at) ON lms.tenant_settings TO lms_app;

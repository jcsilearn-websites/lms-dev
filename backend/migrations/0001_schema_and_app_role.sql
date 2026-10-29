-- Dedicated schema + application role. Portable Postgres only (no Supabase-specific objects).
-- The role "lms_app" is created WITHOUT a password here; `pnpm db:migrate` sets it from
-- LMS_APP_PASSWORD via ALTER ROLE so no secret is ever committed.

CREATE SCHEMA IF NOT EXISTS lms;

REVOKE ALL ON SCHEMA lms FROM PUBLIC;

-- Supabase-compatible hardening: these roles exist on Supabase (and are created in CI).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA lms FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA lms REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA lms REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA lms REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_app') THEN
    CREATE ROLE lms_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- Guard rails against runaway queries / leaked transactions from application code.
ALTER ROLE lms_app SET statement_timeout = '30s';
ALTER ROLE lms_app SET idle_in_transaction_session_timeout = '30s';

GRANT USAGE ON SCHEMA lms TO lms_app;

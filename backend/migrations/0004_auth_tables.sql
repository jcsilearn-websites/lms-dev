-- Step 2: authentication tables.
-- user_credentials, auth_tokens and platform_audit_log have RLS enabled + forced and NO policy and
-- NO grant for lms_app: they are reachable only through the SECURITY DEFINER functions (0005).

CREATE TYPE lms.auth_token_purpose AS ENUM ('invite', 'password_reset');

-- ---------------------------------------------------------------- user_credentials
CREATE TABLE lms.user_credentials (
  user_id uuid PRIMARY KEY REFERENCES lms.users (id) ON DELETE CASCADE,
  password_hash text NOT NULL,  -- argon2id, PHC string format
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- sessions
-- tenant_id NULL = platform-admin session (admin.<domain>).
CREATE TABLE lms.sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL,  -- SHA-256 of the cookie token; the token itself is never stored
  user_id uuid NOT NULL REFERENCES lms.users (id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES lms.tenants (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text CHECK (length(user_agent) <= 512),
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  -- a tenant session must belong to a member of that tenant (not enforced when tenant_id IS NULL,
  -- which is why user_id ALSO has the plain FK above); removing the member removes the sessions
  CONSTRAINT sessions_membership_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES lms.tenant_memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX sessions_tenant_user_idx ON lms.sessions (tenant_id, user_id, created_at DESC);
CREATE INDEX sessions_user_active_idx ON lms.sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- auth_tokens (invites + password resets)
CREATE TABLE lms.auth_tokens (
  id uuid PRIMARY KEY,
  purpose lms.auth_token_purpose NOT NULL,
  token_hash bytea NOT NULL,  -- SHA-256 of the emailed token; single use
  user_id uuid NOT NULL REFERENCES lms.users (id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES lms.tenants (id),
  membership_id uuid,
  created_by_user_id uuid REFERENCES lms.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT auth_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT auth_tokens_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT auth_tokens_invite_has_membership CHECK ((purpose = 'invite') = (membership_id IS NOT NULL)),
  CONSTRAINT auth_tokens_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_tokens_tenant_user_idx ON lms.auth_tokens (tenant_id, user_id, purpose);
CREATE INDEX auth_tokens_user_open_idx ON lms.auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ---------------------------------------------------------------- platform_audit_log (no tenant)
CREATE TABLE lms.platform_audit_log (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES lms.users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_log_created_idx ON lms.platform_audit_log (created_at DESC, id DESC);

-- ---------------------------------------------------------------- RLS
ALTER TABLE lms.user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.user_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.auth_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.platform_audit_log FORCE ROW LEVEL SECURITY;

-- A session row is visible/changeable only by its own user, in the matching tenant context
-- (tenant_id NULL for platform sessions matches an unset tenant).
CREATE POLICY sessions_own ON lms.sessions FOR ALL TO lms_app
  USING (
    user_id = (SELECT lms.current_user_id())
    AND tenant_id IS NOT DISTINCT FROM (SELECT lms.current_tenant_id())
  )
  WITH CHECK (
    user_id = (SELECT lms.current_user_id())
    AND tenant_id IS NOT DISTINCT FROM (SELECT lms.current_tenant_id())
  );

-- Owner policies on managed Postgres where the owner is neither superuser nor BYPASSRLS (see 0002).
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    FOREACH t IN ARRAY ARRAY['user_credentials', 'sessions', 'auth_tokens', 'platform_audit_log'] LOOP
      EXECUTE format(
        'CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
        t, current_user
      );
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------- grants (least privilege)
-- sessions: create, read own, revoke own. last_seen/idle expiry are bumped by auth_lookup_session.
GRANT SELECT, INSERT ON lms.sessions TO lms_app;
GRANT UPDATE (revoked_at) ON lms.sessions TO lms_app;
-- user_credentials, auth_tokens, platform_audit_log: NO grants to lms_app.

-- Step 14c part 1: two-factor sign-in (TOTP). Part 1 of 2: storage (docs/adr/0026-mfa.md).
-- The factor belongs to the PERSON (identity is global), so these tables have no tenant_id except the challenge, which is bound to
-- the host it was issued on. Like user_credentials: row-level security enabled AND forced, NO policy and NO grant for lms_app, so
-- they are reachable only through the SECURITY DEFINER functions of 0070.
-- The TOTP secret is stored encrypted by the APPLICATION (MFA_ENCRYPTION_KEYS); the database never sees it in the clear.

-- the emailed enrolment link (a value added here is first USED by the functions of the next migration)
ALTER TYPE lms.auth_token_purpose ADD VALUE 'mfa_enrol';

-- ------------------------------------------------------------------ the second factor of a person
CREATE TABLE lms.user_mfa (
  user_id uuid PRIMARY KEY REFERENCES lms.users (id) ON DELETE CASCADE,
  secret_ciphertext bytea NOT NULL,             -- AES-256-GCM ciphertext + tag, the user id is the additional authenticated data
  secret_nonce bytea NOT NULL CHECK (octet_length(secret_nonce) = 12),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 16),
  enabled_at timestamptz NOT NULL,
  last_used_step bigint NOT NULL,               -- replay protection: only a LATER time step is ever accepted
  -- wrong codes in a row, per factor: a locked TOTP counter must not block a recovery code
  totp_failures integer NOT NULL DEFAULT 0 CHECK (totp_failures >= 0),
  totp_locked_until timestamptz,
  totp_lock_reported boolean NOT NULL DEFAULT false,
  recovery_failures integer NOT NULL DEFAULT 0 CHECK (recovery_failures >= 0),
  recovery_locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lms.user_mfa_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lms.user_mfa (user_id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),  -- keyed HMAC-SHA256; the code is shown once and never kept
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX user_mfa_recovery_codes_user_idx ON lms.user_mfa_recovery_codes (user_id);

-- ------------------------------------------------------------------ challenges: "the password (or the emailed link and the password) was right"
CREATE TABLE lms.auth_mfa_challenges (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),  -- SHA-256 of the cookie token
  user_id uuid NOT NULL REFERENCES lms.users (id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES lms.tenants (id),                       -- NULL = the admin host; a challenge counts only where it was issued
  purpose text NOT NULL CHECK (purpose IN ('verify', 'enrol')),
  totp_attempts integer NOT NULL DEFAULT 0 CHECK (totp_attempts >= 0),
  recovery_attempts integer NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  -- enrolment: the emailed token it came from and the secret that becomes the factor on confirmation
  enrol_token_id uuid REFERENCES lms.auth_tokens (id) ON DELETE CASCADE,
  pending_ciphertext bytea,
  pending_nonce bytea,
  pending_key_id text,
  ip inet,
  user_agent text CHECK (length(user_agent) <= 512),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT auth_mfa_challenges_token_hash_key UNIQUE (token_hash),
  CONSTRAINT auth_mfa_challenges_enrol CHECK (
    (purpose = 'enrol') = (enrol_token_id IS NOT NULL)
    AND (purpose = 'enrol') = (pending_ciphertext IS NOT NULL AND pending_nonce IS NOT NULL AND pending_key_id IS NOT NULL)
  )
);
CREATE INDEX auth_mfa_challenges_user_idx ON lms.auth_mfa_challenges (user_id);
CREATE INDEX auth_mfa_challenges_expires_idx ON lms.auth_mfa_challenges (expires_at);

-- when the session passed the second factor (NULL: it did not need one)
ALTER TABLE lms.sessions ADD COLUMN mfa_verified_at timestamptz;

-- ------------------------------------------------------------------ RLS (see 0004)
ALTER TABLE lms.user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.user_mfa FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.user_mfa_recovery_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.auth_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.auth_mfa_challenges FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    FOREACH t IN ARRAY ARRAY['user_mfa', 'user_mfa_recovery_codes', 'auth_mfa_challenges'] LOOP
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END LOOP;
  END IF;
END
$$;

-- an erased account never gets a factor or a challenge again (same guard as sessions and tokens, 0066)
CREATE TRIGGER user_mfa_erased_guard BEFORE INSERT ON lms.user_mfa
  FOR EACH ROW EXECUTE FUNCTION lms.guard_erased_user();
CREATE TRIGGER auth_mfa_challenges_erased_guard BEFORE INSERT ON lms.auth_mfa_challenges
  FOR EACH ROW EXECUTE FUNCTION lms.guard_erased_user();

-- ACCOUNT erasure removes the factor in the same transaction, whichever path erases (the execution, or the re-application after a
-- restore): the trigger hangs on the one thing every path does. A college-level erasure does not touch it (it is the global account's).
CREATE FUNCTION lms.mfa_forget_erased_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  DELETE FROM lms.auth_mfa_challenges c WHERE c.user_id = NEW.id;
  DELETE FROM lms.user_mfa m WHERE m.user_id = NEW.id;  -- the recovery codes go with it
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_forget_erased_user() FROM PUBLIC;
CREATE TRIGGER users_erased_forget_mfa AFTER UPDATE OF erased_at ON lms.users
  FOR EACH ROW WHEN (NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL)
  EXECUTE FUNCTION lms.mfa_forget_erased_user();

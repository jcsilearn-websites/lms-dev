-- Step 14c part 2, part 1 of 2: storage for the step-up, the authenticator replacement and the four-eyes reset (docs/adr/0026-mfa.md).

-- A challenge of purpose 'replace' holds the PENDING secret of a signed-in person who is replacing their authenticator.
ALTER TABLE lms.auth_mfa_challenges DROP CONSTRAINT auth_mfa_challenges_purpose_check;
ALTER TABLE lms.auth_mfa_challenges ADD CONSTRAINT auth_mfa_challenges_purpose_check CHECK (purpose IN ('verify', 'enrol', 'replace'));
ALTER TABLE lms.auth_mfa_challenges DROP CONSTRAINT auth_mfa_challenges_enrol;
ALTER TABLE lms.auth_mfa_challenges ADD CONSTRAINT auth_mfa_challenges_enrol CHECK (
  (purpose = 'enrol') = (enrol_token_id IS NOT NULL)
  AND (purpose IN ('enrol', 'replace')) = (pending_ciphertext IS NOT NULL AND pending_nonce IS NOT NULL AND pending_key_id IS NOT NULL)
);

-- ------------------------------------------------------------------ reset of a lost second factor (GLOBAL: no tenant)
CREATE TABLE lms.mfa_reset_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lms.users (id),                 -- the person whose factor would be removed
  status text NOT NULL CHECK (status IN ('pending_approval', 'approved', 'done', 'rejected', 'cancelled', 'expired')),
  requested_at timestamptz NOT NULL,
  requested_by uuid NOT NULL REFERENCES lms.users (id),
  expires_at timestamptz NOT NULL,                                  -- undecided requests end here
  approved_at timestamptz,
  approved_by uuid REFERENCES lms.users (id),
  execute_after timestamptz,
  decided_at timestamptz,
  decided_by uuid REFERENCES lms.users (id),                       -- NULL when the system decided (expiry)
  reason text CHECK (length(reason) <= 60),                         -- why a request ended without the approver's doing
  executed_at timestamptz,
  -- FOUR EYES, in the database: the filer, the approver and the person are three different people
  CONSTRAINT mfa_reset_requests_filer_ck CHECK (requested_by <> user_id),
  CONSTRAINT mfa_reset_requests_approver_ck CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> user_id)),
  CONSTRAINT mfa_reset_requests_approved_ck CHECK (
    status NOT IN ('approved', 'done') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND execute_after IS NOT NULL))
);
CREATE UNIQUE INDEX mfa_reset_requests_one_open ON lms.mfa_reset_requests (user_id) WHERE status IN ('pending_approval', 'approved');
CREATE INDEX mfa_reset_requests_due_idx ON lms.mfa_reset_requests (execute_after) WHERE status = 'approved';
CREATE INDEX mfa_reset_requests_expiry_idx ON lms.mfa_reset_requests (expires_at) WHERE status = 'pending_approval';

-- no policy and no grant for lms_app: reachable only through the definer functions of 0072
ALTER TABLE lms.mfa_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.mfa_reset_requests FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.mfa_reset_requests FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;

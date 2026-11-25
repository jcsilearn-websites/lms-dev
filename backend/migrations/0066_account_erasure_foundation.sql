-- Step 14b-1, part 4a: ACCOUNT-LEVEL ERASURE, the foundation (the functions are migration 0067).
--
-- Erasing the GLOBAL account is allowed only when the person has no non-removed membership anywhere (a member of exactly one college gets a
-- combined request that runs the college erasure first). It pseudonymises the `users` row, deletes the credentials, revokes every session,
-- scrubs every college the person belonged to (the same core as the college erasure) and leaves every college's academic record alone.
--
--   users.erased_at                 set by the erasure; the one flag every reader of the account looks at
--   lms.member_identity             an erased ACCOUNT shows its pseudonym (display_name) and an empty address in every college
--   user_sync_search_keys           follows: an erased account has no search address
--   guard_erased_user               an erased account can never get a membership, an activation, a session or a token again; it takes
--                                   the user row lock FOR SHARE, the erasure holds it FOR UPDATE, so the two can never interleave
--   account_erasure_requests        one row per request; only the definer functions of 0067 touch it (no policy, no grant for lms_app)
--   erasure_requests.with_account   a college request that is the first half of a combined "erase my account" (the administrators see it)
--   erasure_requests.source         'account' = the internal per-college request an account erasure makes (so that the audit scrub,
--                                   which needs an EXECUTING request of that college, stays the only way past the append-only trigger)

ALTER TABLE lms.users ADD COLUMN erased_at timestamptz;

-- ---------------------------------------------------------------- the identity view: an erased account
CREATE OR REPLACE VIEW lms.member_identity WITH (security_invoker = true) AS
SELECT m.tenant_id,
       m.id AS membership_id,
       m.user_id,
       COALESCE(o.pseudonym, u.display_name) AS display_name,
       CASE WHEN o.membership_id IS NULL AND u.erased_at IS NULL THEN u.email ELSE '' END AS email,
       (o.membership_id IS NOT NULL OR u.erased_at IS NOT NULL) AS erased
  FROM lms.tenant_memberships m
  JOIN lms.users u ON u.id = m.user_id
  LEFT JOIN lms.membership_display_overrides o ON o.tenant_id = m.tenant_id AND o.membership_id = m.id;

CREATE OR REPLACE FUNCTION lms.user_sync_search_keys()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.tenant_memberships m
     SET search_name = lower(coalesce((SELECT o.pseudonym FROM lms.membership_display_overrides o
                                        WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id), NEW.display_name)),
         search_email = CASE WHEN NEW.erased_at IS NOT NULL OR EXISTS (SELECT 1 FROM lms.membership_display_overrides o
                                                                        WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id)
                             THEN NULL ELSE NEW.email END
   WHERE m.user_id = NEW.id;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------- an erased account stays erased
-- Locks the user row FOR SHARE first and reads erased_at AFTER the lock: an account erasure (FOR UPDATE on the same row) either finished
-- (then this refuses) or waits for this statement's transaction (then it sees the new membership and refuses itself).
CREATE FUNCTION lms.guard_erased_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_erased timestamptz;
BEGIN
  -- removing a membership is always allowed (it is what the erasure itself does)
  -- (nested: plpgsql resolves NEW.status when the expression is evaluated, and sessions / auth_tokens have no such field)
  IF TG_TABLE_NAME = 'tenant_memberships' THEN
    IF TG_OP = 'UPDATE' AND NEW.status = 'removed' THEN RETURN NEW; END IF;
  END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT u.erased_at INTO v_erased FROM lms.users u WHERE u.id = NEW.user_id FOR SHARE;
  IF v_erased IS NOT NULL THEN
    RAISE EXCEPTION 'the account was erased' USING ERRCODE = 'check_violation', CONSTRAINT = 'account_erased';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_erased_user() FROM PUBLIC;
CREATE TRIGGER tenant_memberships_erased_guard BEFORE INSERT OR UPDATE OF status ON lms.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION lms.guard_erased_user();
CREATE TRIGGER sessions_erased_guard BEFORE INSERT ON lms.sessions
  FOR EACH ROW EXECUTE FUNCTION lms.guard_erased_user();
CREATE TRIGGER auth_tokens_erased_guard BEFORE INSERT ON lms.auth_tokens
  FOR EACH ROW EXECUTE FUNCTION lms.guard_erased_user();

-- ---------------------------------------------------------------- the college requests
ALTER TABLE lms.erasure_requests DROP CONSTRAINT erasure_requests_source_check;
ALTER TABLE lms.erasure_requests ADD CONSTRAINT erasure_requests_source_check CHECK (source IN ('member', 'ledger', 'account'));
ALTER TABLE lms.erasure_requests ADD COLUMN with_account boolean NOT NULL DEFAULT false;
-- an internal 'account' request (made by the account erasure for a college where the person had a removed membership) needs no approval
ALTER TABLE lms.erasure_requests DROP CONSTRAINT erasure_requests_approved_ck;
ALTER TABLE lms.erasure_requests ADD CONSTRAINT erasure_requests_approved_ck CHECK (
  status NOT IN ('approved', 'executing', 'done') OR (grace_until IS NOT NULL AND approved_by IS NOT NULL) OR source IN ('ledger', 'account'));

-- ---------------------------------------------------------------- the account requests (GLOBAL: no tenant)
CREATE TABLE lms.account_erasure_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lms.users (id),
  -- member_combined: the member of exactly one college asked (their college request is the first half); platform: a platform admin
  -- filed it for a person who cannot sign in; ledger: re-applied after a restore
  source text NOT NULL CHECK (source IN ('member_combined', 'platform', 'ledger')),
  status text NOT NULL CHECK (status IN ('waiting_college', 'pending_approval', 'approved', 'executing', 'done', 'cancelled', 'rejected', 'expired')),
  college_request_id uuid REFERENCES lms.erasure_requests (id),
  requested_at timestamptz NOT NULL,
  requested_by uuid REFERENCES lms.users (id),
  expires_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES lms.users (id),
  grace_until timestamptz,
  decided_at timestamptz,
  decided_by uuid REFERENCES lms.users (id),
  reason text CHECK (length(reason) <= 60),
  executed_at timestamptz,
  ledger_at timestamptz,
  CONSTRAINT account_erasure_requests_shape_ck CHECK (
    (source = 'member_combined' AND college_request_id IS NOT NULL) OR (source <> 'member_combined' AND college_request_id IS NULL)),
  CONSTRAINT account_erasure_requests_approved_ck CHECK (
    status NOT IN ('approved', 'executing', 'done') OR source IN ('member_combined', 'ledger') OR (grace_until IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE UNIQUE INDEX account_erasure_requests_one_open ON lms.account_erasure_requests (user_id)
  WHERE status IN ('waiting_college', 'pending_approval', 'approved', 'executing');
CREATE INDEX account_erasure_requests_due_idx ON lms.account_erasure_requests (status, grace_until) WHERE status IN ('approved', 'waiting_college');
CREATE INDEX account_erasure_requests_ledger_idx ON lms.account_erasure_requests (status) WHERE status = 'done' AND ledger_at IS NULL;
CREATE INDEX account_erasure_requests_list_idx ON lms.account_erasure_requests (requested_at DESC, id);

-- no policy and no grant for lms_app: the table has no tenant, so it is reachable only through the definer functions (like user_credentials)
ALTER TABLE lms.account_erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.account_erasure_requests FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.account_erasure_requests FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;

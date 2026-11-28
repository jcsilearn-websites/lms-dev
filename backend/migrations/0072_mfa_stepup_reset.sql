-- Step 14c part 2, part 2 of 2: step-up, the person's own changes to their factor, and the four-eyes reset (docs/adr/0026-mfa.md).
-- Rules kept by every function here:
--   * a change and its audit rows are ONE function (and the security e-mail is queued by the same one);
--   * LOCK ORDER: person advisory lock -> reset request -> user_credentials -> user_mfa -> challenge -> sessions. Every function that
--     may touch a reset request takes the first two BEFORE user_credentials (sign-in included: a sign-in cancels an open reset).
--     Advisory locks are transaction-scoped only;
--   * every time decision takes p_now;
--   * a code is CHARGED (and audited) before it is checked.

-- ------------------------------------------------------------------ security mail: six more templates
CREATE OR REPLACE FUNCTION lms.email_enqueue_security(p_tenant uuid, p_user uuid, p_template text, p_params jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text;
  v_id uuid := lms.uuid_v7();
BEGIN
  IF p_template NOT IN ('invite', 'password_reset', 'password_changed', 'admin_promoted',
                        'mfa_enrol', 'mfa_enrolled', 'mfa_recovery_used', 'mfa_locked',
                        'mfa_replaced', 'mfa_disabled', 'mfa_recovery_regenerated',
                        'mfa_reset_requested', 'mfa_reset_approved', 'mfa_reset_done') THEN
    RAISE EXCEPTION 'not a security template: %', p_template USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'idempotency key required' USING ERRCODE = '22023';
  END IF;
  -- an invite goes only to a PENDING member of that college; anything else to a member of it (or, on the admin host, a user)
  IF p_tenant IS NOT NULL THEN
    SELECT u.email INTO v_email FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
     WHERE m.tenant_id = p_tenant AND m.user_id = p_user
       AND (CASE WHEN p_template = 'invite' THEN m.status = 'pending' ELSE m.status <> 'removed' END);
  ELSE
    SELECT u.email INTO v_email FROM lms.users u WHERE u.id = p_user;
  END IF;
  IF v_email IS NULL OR lms.email_suppressed(v_email, 'security') THEN RETURN false; END IF;
  INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params)
  VALUES (v_id, p_tenant, p_key, p_user, v_email, 'security', p_template, coalesce(p_params, '{}'::jsonb))
  ON CONFLICT ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
  VALUES (lms.uuid_v7(), 'email.send', p_tenant, jsonb_build_object('outboxId', v_id), now(), 5, 'email:' || v_id);
  RETURN true;
END
$$;

-- ------------------------------------------------------------------ the per-request lookup also says whether a factor exists
-- (return type changed: DROP + CREATE). The step-up check needs both columns and must not cost a round trip.
DROP FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer, boolean);
CREATE FUNCTION lms.auth_lookup_session(
  p_token_hash bytea, p_tenant_id uuid, p_touch_seconds integer, p_idle_seconds integer, p_require_mfa boolean DEFAULT false
)
RETURNS TABLE (
  session_id uuid, user_id uuid, tenant_id uuid, membership_role text,
  is_platform_admin boolean, email text, display_name text, mfa_verified_at timestamptz, mfa_enrolled boolean
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH hit AS (
    SELECT s.id AS session_id, s.user_id, s.tenant_id, s.last_seen_at, s.mfa_verified_at,
           m.role::text AS membership_role, u.is_platform_admin, u.email, u.display_name,
           EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = s.user_id) AS mfa_enrolled
    FROM lms.sessions s
    JOIN lms.users u ON u.id = s.user_id
    LEFT JOIN lms.tenant_memberships m
      ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
    LEFT JOIN lms.tenants t ON t.id = s.tenant_id
    WHERE s.token_hash = p_token_hash
      AND s.revoked_at IS NULL
      AND s.idle_expires_at > now()
      AND s.absolute_expires_at > now()
      AND s.tenant_id IS NOT DISTINCT FROM p_tenant_id
      AND (
        (s.tenant_id IS NOT NULL AND m.status = 'active' AND t.status = 'active')
        OR (s.tenant_id IS NULL AND u.is_platform_admin)
      )
      AND NOT (
        p_require_mfa AND s.mfa_verified_at IS NULL
        AND (s.tenant_id IS NULL OR m.role = 'institution_admin')
      )
  ),
  touch AS (
    UPDATE lms.sessions s
       SET last_seen_at = now(),
           idle_expires_at = LEAST(now() + make_interval(secs => p_idle_seconds), s.absolute_expires_at)
     WHERE s.id = (SELECT session_id FROM hit)
       AND s.last_seen_at < now() - make_interval(secs => p_touch_seconds)
    RETURNING s.id
  )
  SELECT h.session_id, h.user_id, h.tenant_id, h.membership_role, h.is_platform_admin, h.email, h.display_name, h.mfa_verified_at,
         h.mfa_enrolled
  FROM hit h
$$;
REVOKE ALL ON FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer, boolean) TO lms_app;

-- ------------------------------------------------------------------ helpers (no grant)
-- Does any role of this person require a second factor? (a factor of such a person cannot be disabled)
CREATE FUNCTION lms.mfa_required_anywhere(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin)
      OR EXISTS (SELECT 1 FROM lms.tenant_memberships m
                  WHERE m.user_id = p_user AND m.role = 'institution_admin' AND m.status <> 'removed')
$$;
REVOKE ALL ON FUNCTION lms.mfa_required_anywhere(uuid) FROM PUBLIC;

-- The first two locks of the order: the person, then their open reset request (NULL when there is none).
CREATE FUNCTION lms.mfa_reset_lock(p_user uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mfa.reset:' || p_user::text, 0));
  SELECT r.id INTO v_id FROM lms.mfa_reset_requests r
   WHERE r.user_id = p_user AND r.status IN ('pending_approval', 'approved') FOR UPDATE;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_lock(uuid) FROM PUBLIC;

-- The platform log AND the log of every college where the person is an active administrator.
CREATE FUNCTION lms.mfa_reset_audit(p_request uuid, p_user uuid, p_actor uuid, p_action text, p_meta jsonb, p_ip inet)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_meta jsonb := p_meta || jsonb_build_object('userId', p_user)
                  || CASE WHEN p_request IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('requestId', p_request) END;
BEGIN
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (lms.uuid_v7(), p_actor, p_action, 'user', p_user::text, v_meta, p_ip);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  SELECT lms.uuid_v7(), m.tenant_id, p_actor, p_action, 'user', p_user::text, v_meta
    FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id AND t.status = 'active'
   WHERE m.user_id = p_user AND m.role = 'institution_admin' AND m.status = 'active';
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_audit(uuid, uuid, uuid, text, jsonb, inet) FROM PUBLIC;

-- Security mail about a reset: from the admin host for a platform admin, else from a college the person administers.
CREATE FUNCTION lms.mfa_reset_mail(p_user uuid, p_template text, p_key text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin) THEN
    SELECT m.tenant_id INTO v_tenant
      FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id AND t.status = 'active'
     WHERE m.user_id = p_user AND m.status <> 'removed'
     ORDER BY (m.role = 'institution_admin' AND m.status = 'active') DESC, m.id
     LIMIT 1;
  END IF;
  PERFORM lms.email_enqueue_security(v_tenant, p_user, p_template, '{}'::jsonb, p_key);
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_mail(uuid, text, text) FROM PUBLIC;

-- The person proved they still have a factor: an open reset ends. The caller holds the two locks of mfa_reset_lock.
CREATE FUNCTION lms.mfa_reset_cancel_by_subject(p_request uuid, p_user uuid, p_reason text, p_ip inet, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF p_request IS NULL THEN RETURN; END IF;
  UPDATE lms.mfa_reset_requests r SET status = 'cancelled', decided_at = p_now, decided_by = p_user, reason = p_reason
   WHERE r.id = p_request AND r.status IN ('pending_approval', 'approved');
  IF FOUND THEN
    PERFORM lms.mfa_reset_audit(p_request, p_user, p_user, 'auth.mfa_reset_cancelled', jsonb_build_object('reason', p_reason), p_ip);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_cancel_by_subject(uuid, uuid, text, inet, timestamptz) FROM PUBLIC;

-- The TOTP lockout of ADR 0026, in one place: charges one attempt of the locked factor row. NULL = charged; a number = locked,
-- that many seconds to wait (nothing is charged; the lock is reported the first time it is hit).
CREATE FUNCTION lms.mfa_totp_charge(
  p_user uuid, p_tenant uuid, p_ip inet, p_lock_audit_id uuid, p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  f lms.user_mfa%ROWTYPE;
  v_failures integer;
BEGIN
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = p_user;
  IF f.totp_locked_until IS NOT NULL AND f.totp_locked_until > p_now THEN
    IF NOT f.totp_lock_reported THEN
      UPDATE lms.user_mfa m SET totp_lock_reported = true, updated_at = p_now WHERE m.user_id = f.user_id;
      PERFORM lms.mfa_audit(p_lock_audit_id, p_tenant, f.user_id, 'auth.mfa_locked',
                            jsonb_build_object('method', 'totp', 'failedAttempts', f.totp_failures), p_ip);
      PERFORM lms.email_enqueue_security(p_tenant, f.user_id, 'mfa_locked', '{}'::jsonb, 'mfa-locked:' || p_lock_audit_id);
    END IF;
    RETURN ceil(extract(epoch FROM f.totp_locked_until - p_now))::integer;
  END IF;
  v_failures := f.totp_failures + 1;
  UPDATE lms.user_mfa m
     SET totp_failures = v_failures,
         totp_locked_until = CASE
           WHEN v_failures >= 20 THEN p_now + interval '24 hours'
           WHEN v_failures >= 5 THEN p_now + make_interval(secs => LEAST(900, 60 * power(2, v_failures - 5)))
         END,
         totp_lock_reported = false,
         updated_at = p_now
   WHERE m.user_id = f.user_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_totp_charge(uuid, uuid, inet, uuid, timestamptz) FROM PUBLIC;

-- ONE recovery code, in a signed-in or signing-in context: checks, counts, consumes. The caller holds the factor row lock.
CREATE FUNCTION lms.mfa_recovery_consume(p_user uuid, p_hashes bytea[], p_key_ids text[], p_now timestamptz)
RETURNS TABLE (r_status text, r_remaining integer, r_retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  f lms.user_mfa%ROWTYPE;
  v_code uuid;
  v_failures integer;
BEGIN
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = p_user;
  IF f.recovery_locked_until IS NOT NULL AND f.recovery_locked_until > p_now THEN
    RETURN QUERY SELECT 'locked'::text, 0, ceil(extract(epoch FROM f.recovery_locked_until - p_now))::integer;
    RETURN;
  END IF;
  SELECT r.id INTO v_code
    FROM lms.user_mfa_recovery_codes r
    JOIN unnest(p_hashes, p_key_ids) AS g(hash, kid) ON g.hash = r.code_hash AND g.kid = r.key_id
   WHERE r.user_id = p_user AND r.used_at IS NULL
   LIMIT 1;
  IF v_code IS NULL THEN
    v_failures := f.recovery_failures + 1;
    UPDATE lms.user_mfa m
       SET recovery_failures = v_failures,
           recovery_locked_until = CASE WHEN v_failures >= 5
             THEN p_now + make_interval(secs => LEAST(900, 60 * power(2, LEAST(v_failures - 5, 20)))) END,
           updated_at = p_now
     WHERE m.user_id = p_user;
    RETURN QUERY SELECT 'wrong'::text, 0, 0;
    RETURN;
  END IF;
  UPDATE lms.user_mfa_recovery_codes r SET used_at = p_now WHERE r.id = v_code;
  -- a recovery code proves possession: both counters start again
  UPDATE lms.user_mfa m
     SET recovery_failures = 0, recovery_locked_until = NULL, totp_failures = 0, totp_locked_until = NULL,
         totp_lock_reported = false, updated_at = p_now
   WHERE m.user_id = p_user;
  RETURN QUERY SELECT 'ok'::text,
    (SELECT count(*)::integer FROM lms.user_mfa_recovery_codes r WHERE r.user_id = p_user AND r.used_at IS NULL), 0;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_recovery_consume(uuid, bytea[], text[], timestamptz) FROM PUBLIC;

-- ------------------------------------------------------------------ the sign-in functions of 0070, now aware of the reset
-- Same signatures (CREATE OR REPLACE: grants stay).
CREATE OR REPLACE FUNCTION lms.mfa_totp_attempt(
  p_challenge_hash bytea, p_tenant uuid, p_max_per_challenge integer, p_ip inet, p_audit_id uuid, p_lock_audit_id uuid,
  p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_ciphertext bytea, r_nonce bytea, r_key_id text, r_retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  f lms.user_mfa%ROWTYPE;
  c lms.auth_mfa_challenges%ROWTYPE;
  v_wait integer;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  -- credentials first (see mfa_enrol_attempt)
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR NO KEY UPDATE;
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = v_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::bytea, NULL::bytea, NULL::text, 0;
    RETURN;
  END IF;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash FOR UPDATE;
  IF c.purpose <> 'verify' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant
     OR c.totp_attempts >= p_max_per_challenge THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::bytea, NULL::bytea, NULL::text, 0;
    RETURN;
  END IF;
  v_wait := lms.mfa_totp_charge(f.user_id, p_tenant, p_ip, p_lock_audit_id, p_now);
  IF v_wait IS NOT NULL THEN
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::bytea, NULL::bytea, NULL::text, v_wait;
    RETURN;
  END IF;
  UPDATE lms.auth_mfa_challenges x SET totp_attempts = x.totp_attempts + 1 WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, f.user_id, 'auth.mfa_attempt', jsonb_build_object('method', 'totp'), p_ip);
  RETURN QUERY SELECT 'ok'::text, f.user_id, f.secret_ciphertext, f.secret_nonce, f.key_id, 0;
END
$$;

CREATE OR REPLACE FUNCTION lms.mfa_totp_accept(
  p_challenge_hash bytea, p_tenant uuid, p_step bigint, p_session_id uuid, p_session_hash bytea, p_idle_seconds integer,
  p_absolute_seconds integer, p_ip inet, p_user_agent text, p_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_email text, r_display_name text, r_role text, r_is_platform_admin boolean,
               r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_reset uuid;
  f lms.user_mfa%ROWTYPE;
  c lms.auth_mfa_challenges%ROWTYPE;
  s record;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  v_reset := lms.mfa_reset_lock(v_user);
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR NO KEY UPDATE;
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = v_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash FOR UPDATE;
  IF c.purpose <> 'verify' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_step <= f.last_used_step THEN
    RETURN QUERY SELECT 'replayed'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO s FROM lms.session_insert(f.user_id, p_tenant, p_session_id, p_session_hash, p_idle_seconds,
                                              p_absolute_seconds, p_ip, p_user_agent, p_now);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE lms.user_mfa m
     SET last_used_step = p_step, totp_failures = 0, totp_locked_until = NULL, totp_lock_reported = false, updated_at = p_now
   WHERE m.user_id = f.user_id;
  UPDATE lms.auth_mfa_challenges x SET used_at = p_now WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, f.user_id, 'auth.login_succeeded', jsonb_build_object('mfa', 'totp'), p_ip);
  PERFORM lms.mfa_reset_cancel_by_subject(v_reset, f.user_id, 'subject_signed_in', p_ip, p_now);
  RETURN QUERY SELECT 'ok'::text, f.user_id, s.r_email, s.r_display_name, s.r_role, s.r_is_platform_admin, s.r_expires_at;
END
$$;

CREATE OR REPLACE FUNCTION lms.mfa_recovery_use(
  p_challenge_hash bytea, p_tenant uuid, p_hashes bytea[], p_key_ids text[], p_max_per_challenge integer,
  p_session_id uuid, p_session_hash bytea, p_idle_seconds integer, p_absolute_seconds integer, p_ip inet, p_user_agent text,
  p_audit_id uuid, p_login_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_email text, r_display_name text, r_role text, r_is_platform_admin boolean,
               r_expires_at timestamptz, r_retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_reset uuid;
  c lms.auth_mfa_challenges%ROWTYPE;
  k record;
  s record;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  v_reset := lms.mfa_reset_lock(v_user);
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = v_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash FOR UPDATE;
  IF c.purpose <> 'verify' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant
     OR c.recovery_attempts >= p_max_per_challenge THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;
  -- a signing-in person must be allowed to sign in HERE before a code is spent (nothing is consumed or counted otherwise)
  IF p_tenant IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id
                    WHERE m.tenant_id = p_tenant AND m.user_id = v_user AND m.status = 'active' AND t.status = 'active') THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
      RETURN;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = v_user AND u.is_platform_admin) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;
  SELECT * INTO k FROM lms.mfa_recovery_consume(v_user, p_hashes, p_key_ids, p_now);
  IF k.r_status = 'locked' THEN
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz,
                        k.r_retry_after;
    RETURN;
  END IF;
  UPDATE lms.auth_mfa_challenges x SET recovery_attempts = x.recovery_attempts + 1 WHERE x.id = c.id;
  IF k.r_status = 'wrong' THEN
    PERFORM lms.mfa_audit(p_audit_id, p_tenant, v_user, 'auth.mfa_failed', jsonb_build_object('method', 'recovery'), p_ip);
    RETURN QUERY SELECT 'wrong'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;
  SELECT * INTO s FROM lms.session_insert(v_user, p_tenant, p_session_id, p_session_hash, p_idle_seconds,
                                              p_absolute_seconds, p_ip, p_user_agent, p_now);
  IF NOT FOUND THEN
    -- cannot happen (checked above under the credential lock); if it ever does, nothing of this call survives
    RAISE EXCEPTION 'the account may not sign in here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE lms.auth_mfa_challenges x SET used_at = p_now WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, v_user, 'auth.mfa_recovery_used',
                        jsonb_build_object('remaining', k.r_remaining), p_ip);
  PERFORM lms.mfa_audit(p_login_audit_id, p_tenant, v_user, 'auth.login_succeeded', jsonb_build_object('mfa', 'recovery'), p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, v_user, 'mfa_recovery_used',
                                     jsonb_build_object('remaining', k.r_remaining), 'mfa-recovery:' || p_audit_id);
  PERFORM lms.mfa_reset_cancel_by_subject(v_reset, v_user, 'subject_signed_in', p_ip, p_now);
  RETURN QUERY SELECT 'ok'::text, v_user, s.r_email, s.r_display_name, s.r_role, s.r_is_platform_admin, s.r_expires_at, 0;
END
$$;

-- ------------------------------------------------------------------ step-up: the second factor again, inside a session
-- Is this session live, this person's and of this host? (read only; the writes below carry the same condition)
CREATE FUNCTION lms.mfa_session_live(p_session uuid, p_user uuid, p_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM lms.sessions s
                  WHERE s.id = p_session AND s.user_id = p_user AND s.tenant_id IS NOT DISTINCT FROM p_tenant
                    AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now())
$$;
REVOKE ALL ON FUNCTION lms.mfa_session_live(uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION lms.mfa_stepup_attempt(
  p_user uuid, p_session uuid, p_tenant uuid, p_ip inet, p_audit_id uuid, p_lock_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_ciphertext bytea, r_nonce bytea, r_key_id text, r_retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  f lms.user_mfa%ROWTYPE;
  v_wait integer;
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_enrolled'::text, NULL::bytea, NULL::bytea, NULL::text, 0;
    RETURN;
  END IF;
  IF NOT lms.mfa_session_live(p_session, p_user, p_tenant) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::bytea, NULL::bytea, NULL::text, 0;
    RETURN;
  END IF;
  v_wait := lms.mfa_totp_charge(p_user, p_tenant, p_ip, p_lock_audit_id, p_now);
  IF v_wait IS NOT NULL THEN
    RETURN QUERY SELECT 'locked'::text, NULL::bytea, NULL::bytea, NULL::text, v_wait;
    RETURN;
  END IF;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_attempt', jsonb_build_object('method', 'step_up'), p_ip);
  RETURN QUERY SELECT 'ok'::text, f.secret_ciphertext, f.secret_nonce, f.key_id, 0;
END
$$;

-- The code of time step p_step matched: accepted only for a LATER step (two simultaneous step-ups with one code: one wins).
CREATE FUNCTION lms.mfa_stepup_accept(
  p_user uuid, p_session uuid, p_tenant uuid, p_step bigint, p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  f lms.user_mfa%ROWTYPE;
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF p_step <= f.last_used_step THEN RETURN 'replayed'; END IF;
  UPDATE lms.sessions s SET mfa_verified_at = p_now
   WHERE s.id = p_session AND s.user_id = p_user AND s.tenant_id IS NOT DISTINCT FROM p_tenant AND s.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  UPDATE lms.user_mfa m
     SET last_used_step = p_step, totp_failures = 0, totp_locked_until = NULL, totp_lock_reported = false, updated_at = p_now
   WHERE m.user_id = p_user;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_step_up', jsonb_build_object('method', 'totp'), p_ip);
  RETURN 'ok';
END
$$;

CREATE FUNCTION lms.mfa_stepup_recovery(
  p_user uuid, p_session uuid, p_tenant uuid, p_hashes bytea[], p_key_ids text[], p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  k record;
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_enrolled'::text, 0;
    RETURN;
  END IF;
  IF NOT lms.mfa_session_live(p_session, p_user, p_tenant) THEN
    RETURN QUERY SELECT 'invalid'::text, 0;
    RETURN;
  END IF;
  SELECT * INTO k FROM lms.mfa_recovery_consume(p_user, p_hashes, p_key_ids, p_now);
  IF k.r_status = 'locked' THEN
    RETURN QUERY SELECT 'locked'::text, k.r_retry_after;
    RETURN;
  END IF;
  IF k.r_status = 'wrong' THEN
    PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_failed', jsonb_build_object('method', 'recovery'), p_ip);
    RETURN QUERY SELECT 'wrong'::text, 0;
    RETURN;
  END IF;
  UPDATE lms.sessions s SET mfa_verified_at = p_now
   WHERE s.id = p_session AND s.user_id = p_user AND s.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the session ended' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_step_up',
                        jsonb_build_object('method', 'recovery', 'remaining', k.r_remaining), p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, p_user, 'mfa_recovery_used',
                                     jsonb_build_object('remaining', k.r_remaining), 'mfa-recovery:' || p_audit_id);
  RETURN QUERY SELECT 'ok'::text, 0;
END
$$;

-- ------------------------------------------------------------------ the person's own factor (every route needs a step-up)
CREATE FUNCTION lms.mfa_recovery_regenerate(
  p_user uuid, p_tenant uuid, p_code_ids uuid[], p_code_hashes bytea[], p_code_key_id text, p_ip inet, p_audit_id uuid,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM lms.user_mfa_recovery_codes r WHERE r.user_id = p_user;
  INSERT INTO lms.user_mfa_recovery_codes (id, user_id, code_hash, key_id, created_at)
  SELECT p_code_ids[i], p_user, p_code_hashes[i], p_code_key_id, p_now FROM generate_subscripts(p_code_ids, 1) AS i;
  UPDATE lms.user_mfa m SET recovery_failures = 0, recovery_locked_until = NULL, updated_at = p_now WHERE m.user_id = p_user;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_recovery_regenerated', '{}'::jsonb, p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, p_user, 'mfa_recovery_regenerated', '{}'::jsonb, 'mfa-codes:' || p_audit_id);
  RETURN true;
END
$$;

CREATE FUNCTION lms.mfa_replace_start(
  p_user uuid, p_tenant uuid, p_id uuid, p_challenge_hash bytea, p_ciphertext bytea, p_nonce bytea, p_key_id text,
  p_ttl_seconds integer, p_ip inet, p_user_agent text, p_audit_id uuid, p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE lms.auth_mfa_challenges c SET used_at = p_now WHERE c.user_id = p_user AND c.purpose = 'replace' AND c.used_at IS NULL;
  INSERT INTO lms.auth_mfa_challenges
    (id, token_hash, user_id, tenant_id, purpose, pending_ciphertext, pending_nonce, pending_key_id, ip, user_agent, created_at,
     expires_at)
  VALUES (p_id, p_challenge_hash, p_user, p_tenant, 'replace', p_ciphertext, p_nonce, p_key_id, p_ip, left(p_user_agent, 512), p_now,
          p_now + make_interval(secs => p_ttl_seconds));
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_replace_started', '{}'::jsonb, p_ip);
  RETURN true;
END
$$;

CREATE FUNCTION lms.mfa_replace_attempt(
  p_user uuid, p_challenge_hash bytea, p_tenant uuid, p_max integer, p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_ciphertext bytea, r_nonce bytea, r_key_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  c lms.auth_mfa_challenges%ROWTYPE;
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash AND x.user_id = p_user FOR UPDATE;
  IF NOT FOUND OR c.purpose <> 'replace' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant
     OR c.totp_attempts >= p_max THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::bytea, NULL::bytea, NULL::text;
    RETURN;
  END IF;
  UPDATE lms.auth_mfa_challenges x SET totp_attempts = x.totp_attempts + 1 WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_attempt', jsonb_build_object('method', 'replace'), p_ip);
  RETURN QUERY SELECT 'ok'::text, c.pending_ciphertext, c.pending_nonce, c.pending_key_id;
END
$$;

-- The new app showed a right code: its secret replaces the old one; every OTHER session ends. Recovery codes stay.
CREATE FUNCTION lms.mfa_replace_complete(
  p_user uuid, p_challenge_hash bytea, p_tenant uuid, p_step bigint, p_session uuid, p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  c lms.auth_mfa_challenges%ROWTYPE;
BEGIN
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash AND x.user_id = p_user FOR UPDATE;
  IF NOT FOUND OR c.purpose <> 'replace' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant
  THEN RETURN false; END IF;
  UPDATE lms.user_mfa m
     SET secret_ciphertext = c.pending_ciphertext, secret_nonce = c.pending_nonce, key_id = c.pending_key_id,
         enabled_at = p_now, last_used_step = p_step, totp_failures = 0, totp_locked_until = NULL, totp_lock_reported = false,
         updated_at = p_now
   WHERE m.user_id = p_user;
  UPDATE lms.auth_mfa_challenges x SET used_at = p_now WHERE x.user_id = p_user AND x.used_at IS NULL;
  UPDATE lms.sessions s SET revoked_at = now() WHERE s.user_id = p_user AND s.revoked_at IS NULL AND s.id <> p_session;
  UPDATE lms.sessions s SET mfa_verified_at = p_now WHERE s.id = p_session AND s.user_id = p_user;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_replaced', '{}'::jsonb, p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, p_user, 'mfa_replaced', '{}'::jsonb, 'mfa-replaced:' || p_audit_id);
  RETURN true;
END
$$;

CREATE FUNCTION lms.mfa_disable(
  p_user uuid, p_tenant uuid, p_session uuid, p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_reset uuid;
BEGIN
  v_reset := lms.mfa_reset_lock(p_user);
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = p_user FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_enrolled'; END IF;
  -- decided under the locks
  IF lms.mfa_required_anywhere(p_user) THEN RETURN 'required'; END IF;
  DELETE FROM lms.auth_mfa_challenges c WHERE c.user_id = p_user;
  DELETE FROM lms.user_mfa m WHERE m.user_id = p_user;
  UPDATE lms.sessions s SET revoked_at = now() WHERE s.user_id = p_user AND s.revoked_at IS NULL AND s.id <> p_session;
  UPDATE lms.sessions s SET mfa_verified_at = NULL WHERE s.id = p_session AND s.user_id = p_user;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_disabled', '{}'::jsonb, p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, p_user, 'mfa_disabled', '{}'::jsonb, 'mfa-disabled:' || p_audit_id);
  PERFORM lms.mfa_reset_cancel_by_subject(v_reset, p_user, 'subject_disabled', p_ip, p_now);
  RETURN 'ok';
END
$$;

-- (return type changed: DROP + CREATE)
DROP FUNCTION lms.mfa_status(uuid);
CREATE FUNCTION lms.mfa_status(p_user uuid)
RETURNS TABLE (r_enrolled_at timestamptz, r_recovery_remaining integer, r_can_disable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT m.enabled_at,
         (SELECT count(*)::integer FROM lms.user_mfa_recovery_codes r WHERE r.user_id = m.user_id AND r.used_at IS NULL),
         (m.user_id IS NOT NULL AND NOT lms.mfa_required_anywhere(p_user))
  FROM (SELECT 1) one LEFT JOIN lms.user_mfa m ON m.user_id = p_user
$$;

-- ------------------------------------------------------------------ the four-eyes reset (platform administrators)
CREATE FUNCTION lms.mfa_reset_json(r lms.mfa_reset_requests)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'expiresAt', r.expires_at,
                            'executeAfter', r.execute_after)
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_json(lms.mfa_reset_requests) FROM PUBLIC;

CREATE FUNCTION lms.mfa_platform_actor(p_actor uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users a WHERE a.id = p_actor AND a.is_platform_admin) THEN
    RAISE EXCEPTION 'the actor is not a platform administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_platform_actor(uuid) FROM PUBLIC;

CREATE FUNCTION lms.mfa_reset_request(p_actor uuid, p_email text, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_open uuid;
  v_id uuid := lms.uuid_v7();
  r lms.mfa_reset_requests;
BEGIN
  PERFORM lms.mfa_platform_actor(p_actor);
  SELECT u.id INTO v_user FROM lms.users u WHERE u.email = lower(btrim(p_email)) AND u.erased_at IS NULL;
  IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_user = p_actor THEN RETURN jsonb_build_object('result', 'self'); END IF;
  v_open := lms.mfa_reset_lock(v_user);
  IF v_open IS NOT NULL THEN
    SELECT * INTO r FROM lms.mfa_reset_requests e WHERE e.id = v_open;
    -- an undecided request that already ran out does not block a new one (the scheduled run may not have seen it yet)
    IF r.status = 'pending_approval' AND r.expires_at <= p_now THEN
      UPDATE lms.mfa_reset_requests e SET status = 'expired', decided_at = p_now WHERE e.id = r.id;
      PERFORM lms.mfa_reset_audit(r.id, v_user, NULL, 'auth.mfa_reset_expired', '{}'::jsonb, NULL);
    ELSE
      RETURN jsonb_build_object('result', 'in_progress', 'request', lms.mfa_reset_json(r));
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = v_user) THEN RETURN jsonb_build_object('result', 'not_enrolled'); END IF;
  INSERT INTO lms.mfa_reset_requests (id, user_id, status, requested_at, requested_by, expires_at)
  VALUES (v_id, v_user, 'pending_approval', p_now, p_actor, p_now + interval '7 days')
  RETURNING * INTO r;
  PERFORM lms.mfa_reset_audit(v_id, v_user, p_actor, 'auth.mfa_reset_requested', '{}'::jsonb, p_ip);
  PERFORM lms.mfa_reset_mail(v_user, 'mfa_reset_requested', 'mfa-reset-requested:' || v_id);
  RETURN jsonb_build_object('result', 'ok', 'request', lms.mfa_reset_json(r));
END
$$;

CREATE FUNCTION lms.mfa_reset_decide(p_actor uuid, p_id uuid, p_action text, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  r lms.mfa_reset_requests;
  v_status text;
BEGIN
  IF p_action NOT IN ('approve', 'reject', 'cancel') THEN RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023'; END IF;
  PERFORM lms.mfa_platform_actor(p_actor);
  SELECT e.user_id INTO v_user FROM lms.mfa_reset_requests e WHERE e.id = p_id;
  IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mfa.reset:' || v_user::text, 0));
  -- the status is read from the row this statement locks: a decision, a sign-in or the execution in between is seen
  SELECT * INTO r FROM lms.mfa_reset_requests e WHERE e.id = p_id FOR UPDATE;
  IF p_action = 'cancel' THEN
    IF r.status NOT IN ('pending_approval', 'approved') THEN RETURN jsonb_build_object('result', 'too_late', 'status', r.status); END IF;
    v_status := 'cancelled';
  ELSE
    IF p_actor = r.requested_by OR p_actor = r.user_id THEN RETURN jsonb_build_object('result', 'self_approval'); END IF;
    IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('result', 'not_pending', 'status', r.status); END IF;
    IF p_now >= r.expires_at THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    v_status := CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END;
  END IF;
  IF v_status = 'approved' THEN
    IF NOT EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = r.user_id) THEN
      RETURN jsonb_build_object('result', 'not_enrolled');
    END IF;
    UPDATE lms.mfa_reset_requests e
       SET status = 'approved', approved_at = p_now, approved_by = p_actor, execute_after = p_now + interval '24 hours',
           decided_at = p_now, decided_by = p_actor
     WHERE e.id = p_id RETURNING * INTO r;
  ELSE
    UPDATE lms.mfa_reset_requests e SET status = v_status, decided_at = p_now, decided_by = p_actor
     WHERE e.id = p_id RETURNING * INTO r;
  END IF;
  PERFORM lms.mfa_reset_audit(p_id, r.user_id, p_actor, 'auth.mfa_reset_' || v_status, '{}'::jsonb, p_ip);
  IF v_status = 'approved' THEN
    PERFORM lms.mfa_reset_mail(r.user_id, 'mfa_reset_approved', 'mfa-reset-approved:' || p_id);
  END IF;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.mfa_reset_json(r));
END
$$;

-- keyset (newest first); names are those of the stored accounts (global people: platform administrators only)
CREATE FUNCTION lms.mfa_reset_list(p_actor uuid, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
BEGIN
  PERFORM lms.mfa_platform_actor(p_actor);
  RETURN (
    WITH page AS (
      SELECT r.* FROM lms.mfa_reset_requests r
       -- ids are UUIDv7: newest first, and the id of the last row of a page is the whole cursor
       WHERE p_after IS NULL OR r.id < p_after
       ORDER BY r.id DESC LIMIT v_limit + 1)
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'id', p.id, 'status', p.status, 'requestedAt', p.requested_at, 'expiresAt', p.expires_at,
                  'executeAfter', p.execute_after, 'executedAt', p.executed_at, 'reason', p.reason,
                  'personName', u.display_name, 'personEmail', CASE WHEN u.erased_at IS NULL THEN u.email END,
                  'requestedByName', f.display_name, 'approvedByName', a.display_name,
                  'canApprove', p.status = 'pending_approval' AND p.requested_by <> p_actor AND p.user_id <> p_actor,
                  'canCancel', p.status IN ('pending_approval', 'approved')) ORDER BY p.id DESC)
                  FROM (SELECT * FROM page ORDER BY id DESC LIMIT v_limit) p
                  JOIN lms.users u ON u.id = p.user_id
                  JOIN lms.users f ON f.id = p.requested_by
                  LEFT JOIN lms.users a ON a.id = p.approved_by), '[]'::jsonb),
      'hasMore', (SELECT count(*) > v_limit FROM page))
  );
END
$$;

-- worker: undecided requests end after 7 days
CREATE FUNCTION lms.mfa_reset_expire(p_now timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.mfa_reset_requests;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM lms.mfa_reset_requests e WHERE e.status = 'pending_approval' AND e.expires_at <= p_now
            ORDER BY e.expires_at, e.id LIMIT least(greatest(p_limit, 1), 500) FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE lms.mfa_reset_requests e SET status = 'expired', decided_at = p_now WHERE e.id = r.id;
    PERFORM lms.mfa_reset_audit(r.id, r.user_id, NULL, 'auth.mfa_reset_expired', '{}'::jsonb, NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

CREATE FUNCTION lms.mfa_reset_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (r_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT e.id FROM lms.mfa_reset_requests e
   WHERE e.status = 'approved' AND e.execute_after <= p_now
   ORDER BY e.execute_after, e.id LIMIT least(greatest(p_limit, 1), 200)
$$;

-- What a reset DOES (internal): the factor, its codes and challenges go; every session ends; the password stops working; open
-- password-reset and enrolment links die. The row of the credentials stays (so "forgot password" can reach the person).
-- The caller holds the person lock, the request and the credential and factor rows.
CREATE FUNCTION lms.mfa_reset_core(p_user uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_sessions integer;
BEGIN
  DELETE FROM lms.auth_mfa_challenges c WHERE c.user_id = p_user;
  DELETE FROM lms.user_mfa m WHERE m.user_id = p_user;  -- the recovery codes go with it
  UPDATE lms.user_credentials c
     -- not a PHC string: no password verifies against it
     SET password_hash = '!reset', password_updated_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE c.user_id = p_user;
  UPDATE lms.sessions s SET revoked_at = now() WHERE s.user_id = p_user AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  UPDATE lms.auth_tokens a SET used_at = p_now
   WHERE a.user_id = p_user AND a.used_at IS NULL AND a.purpose IN ('password_reset', 'mfa_enrol');
  RETURN jsonb_build_object('sessionsRevoked', v_sessions);
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_reset_core(uuid, timestamptz) FROM PUBLIC;

CREATE FUNCTION lms.mfa_reset_execute(p_id uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  r lms.mfa_reset_requests;
  v_counts jsonb;
BEGIN
  SELECT e.user_id INTO v_user FROM lms.mfa_reset_requests e WHERE e.id = p_id;
  IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mfa.reset:' || v_user::text, 0));
  SELECT * INTO r FROM lms.mfa_reset_requests e WHERE e.id = p_id FOR UPDATE;
  IF r.status <> 'approved' THEN RETURN jsonb_build_object('result', 'skip', 'status', r.status); END IF;
  IF p_now < r.execute_after THEN RETURN jsonb_build_object('result', 'not_due'); END IF;
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = v_user FOR UPDATE;
  -- no factor any more (the account was erased, or it was disabled): nothing to reset, and the password is left alone
  IF NOT FOUND THEN
    UPDATE lms.mfa_reset_requests e SET status = 'cancelled', decided_at = p_now, reason = 'no_factor' WHERE e.id = p_id;
    PERFORM lms.mfa_reset_audit(p_id, v_user, NULL, 'auth.mfa_reset_cancelled', jsonb_build_object('reason', 'no_factor'), NULL);
    RETURN jsonb_build_object('result', 'cancelled');
  END IF;
  v_counts := lms.mfa_reset_core(v_user, p_now);
  UPDATE lms.mfa_reset_requests e SET status = 'done', executed_at = p_now WHERE e.id = p_id;
  PERFORM lms.mfa_reset_audit(p_id, v_user, NULL, 'auth.mfa_reset_executed', v_counts, NULL);
  PERFORM lms.mfa_reset_mail(v_user, 'mfa_reset_done', 'mfa-reset-done:' || p_id);
  RETURN jsonb_build_object('result', 'ok');
END
$$;

-- BREAK GLASS (pnpm mfa:reset, the OWNER connection only: no grant): the same effect at once, without the four eyes.
CREATE FUNCTION lms.mfa_break_glass(p_email text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_open uuid;
  v_counts jsonb;
  v_ref uuid := lms.uuid_v7();
BEGIN
  SELECT u.id INTO v_user FROM lms.users u WHERE u.email = lower(btrim(p_email)) AND u.erased_at IS NULL;
  IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  v_open := lms.mfa_reset_lock(v_user);
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR UPDATE;
  PERFORM 1 FROM lms.user_mfa m WHERE m.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_enrolled'); END IF;
  IF v_open IS NOT NULL THEN
    UPDATE lms.mfa_reset_requests e SET status = 'cancelled', decided_at = p_now, reason = 'break_glass' WHERE e.id = v_open;
  END IF;
  v_counts := lms.mfa_reset_core(v_user, p_now);
  PERFORM lms.mfa_reset_audit(v_open, v_user, NULL, 'auth.mfa_reset_break_glass', v_counts, NULL);
  PERFORM lms.mfa_reset_mail(v_user, 'mfa_reset_done', 'mfa-break-glass:' || v_ref);
  RETURN jsonb_build_object('result', 'ok', 'userId', v_user, 'counts', v_counts);
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_break_glass(text, timestamptz) FROM PUBLIC;

-- ------------------------------------------------------------------ privileges
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mfa_stepup_attempt(uuid, uuid, uuid, inet, uuid, uuid, timestamptz)',
    'mfa_stepup_accept(uuid, uuid, uuid, bigint, inet, uuid, timestamptz)',
    'mfa_stepup_recovery(uuid, uuid, uuid, bytea[], text[], inet, uuid, timestamptz)',
    'mfa_recovery_regenerate(uuid, uuid, uuid[], bytea[], text, inet, uuid, timestamptz)',
    'mfa_replace_start(uuid, uuid, uuid, bytea, bytea, bytea, text, integer, inet, text, uuid, timestamptz)',
    'mfa_replace_attempt(uuid, bytea, uuid, integer, inet, uuid, timestamptz)',
    'mfa_replace_complete(uuid, bytea, uuid, bigint, uuid, inet, uuid, timestamptz)',
    'mfa_disable(uuid, uuid, uuid, inet, uuid, timestamptz)',
    'mfa_status(uuid)',
    'mfa_reset_request(uuid, text, inet, timestamptz)',
    'mfa_reset_decide(uuid, uuid, text, inet, timestamptz)',
    'mfa_reset_list(uuid, integer, uuid)',
    'mfa_reset_expire(timestamptz, integer)',
    'mfa_reset_due(timestamptz, integer)',
    'mfa_reset_execute(uuid, timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

-- Step 14c part 1, part 2 of 2: sign-in, enrolment and verification (docs/adr/0026-mfa.md).
-- Rules kept by every function here:
--   * a change and its audit row are ONE function (tenant host: audit_log; admin host: platform_audit_log);
--   * LOCK ORDER: user_credentials -> user_mfa -> challenge -> sessions (the order account erasure uses);
--   * every time decision takes p_now;
--   * an attempt is CHARGED (and audited) before it is checked: parallel guesses cannot outrun a counter.

-- ------------------------------------------------------------------ helpers (no grant)
CREATE FUNCTION lms.mfa_audit(p_id uuid, p_tenant uuid, p_user uuid, p_action text, p_meta jsonb, p_ip inet)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF p_tenant IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_id, p_tenant, p_user, p_action, 'user', p_user::text,
            p_meta || CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_id, p_user, p_action, 'user', p_user::text, p_meta, p_ip);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_audit(uuid, uuid, uuid, text, jsonb, inet) FROM PUBLIC;

-- Must this person use a second factor on this host? (platform admin on the admin host, institution admin of the college)
CREATE FUNCTION lms.mfa_required_here(p_user uuid, p_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT CASE WHEN p_tenant IS NULL
    THEN EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin)
    ELSE EXISTS (SELECT 1 FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id AND t.status = 'active'
                  WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active' AND m.role = 'institution_admin')
  END
$$;
REVOKE ALL ON FUNCTION lms.mfa_required_here(uuid, uuid) FROM PUBLIC;

-- Creates the session after re-validating that the person may sign in on this host. No row = may not (nothing was written).
CREATE FUNCTION lms.session_insert(
  p_user uuid, p_tenant uuid, p_session_id uuid, p_token_hash bytea, p_idle_seconds integer, p_absolute_seconds integer,
  p_ip inet, p_user_agent text, p_mfa_verified_at timestamptz
)
RETURNS TABLE (r_email text, r_display_name text, r_role text, r_is_platform_admin boolean, r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text;
  v_name text;
  v_admin boolean;
  v_role text;
  v_abs timestamptz := now() + make_interval(secs => p_absolute_seconds);
BEGIN
  SELECT u.email, u.display_name, u.is_platform_admin INTO v_email, v_name, v_admin FROM lms.users u WHERE u.id = p_user;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_tenant IS NOT NULL THEN
    SELECT m.role::text INTO v_role
    FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active' AND t.status = 'active';
    IF v_role IS NULL THEN RETURN; END IF;
  ELSIF NOT v_admin THEN
    RETURN;
  END IF;
  INSERT INTO lms.sessions
    (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at, ip, user_agent, mfa_verified_at)
  VALUES
    (p_session_id, p_token_hash, p_user, p_tenant, LEAST(now() + make_interval(secs => p_idle_seconds), v_abs), v_abs,
     p_ip, left(p_user_agent, 512), p_mfa_verified_at);
  RETURN QUERY SELECT v_email, v_name, v_role, v_admin, v_abs;
END
$$;
REVOKE ALL ON FUNCTION lms.session_insert(uuid, uuid, uuid, bytea, integer, integer, inet, text, timestamptz) FROM PUBLIC;

-- ------------------------------------------------------------------ the password path
-- Step 1 now also says whether the person has a second factor (return type changed: DROP + CREATE).
DROP FUNCTION lms.auth_login_begin(text, uuid);
CREATE FUNCTION lms.auth_login_begin(p_email text, p_tenant_id uuid)
RETURNS TABLE (
  r_user_id uuid, r_password_hash text, r_locked_until timestamptz, r_is_platform_admin boolean,
  r_tenant_active boolean, r_membership_role text, r_membership_status text, r_mfa_enrolled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT u.id, c.password_hash, c.locked_until, u.is_platform_admin,
         (t.status = 'active'), m.role::text, m.status::text, (f.user_id IS NOT NULL)
  FROM (SELECT 1) one
  LEFT JOIN lms.tenants t ON t.id = p_tenant_id
  LEFT JOIN lms.users u ON u.email = lower(btrim(p_email))
  LEFT JOIN lms.user_credentials c ON c.user_id = u.id
  LEFT JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant_id AND m.user_id = u.id
  LEFT JOIN lms.user_mfa f ON f.user_id = u.id
$$;
REVOKE ALL ON FUNCTION lms.auth_login_begin(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_login_begin(text, uuid) TO lms_app;

-- Step 2 creates a session with NO second factor: it refuses an enrolled person, and (when enforcement is on) a person who must enrol.
DROP FUNCTION lms.auth_login_complete(uuid, uuid, uuid, bytea, integer, integer, inet, text, uuid);
CREATE FUNCTION lms.auth_login_complete(
  p_user_id uuid, p_tenant_id uuid, p_session_id uuid, p_token_hash bytea,
  p_idle_seconds integer, p_absolute_seconds integer, p_ip inet, p_user_agent text,
  p_audit_id uuid, p_require_mfa boolean DEFAULT false
)
RETURNS TABLE (r_status text, r_email text, r_display_name text, r_role text, r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_locked timestamptz;
  s record;
BEGIN
  -- The service decided "not locked" from a read made BEFORE the password check: read it again under the row lock. The same lock
  -- serialises with an enrolment being confirmed (it takes it first, then adds the factor and revokes the sessions).
  SELECT c.locked_until INTO v_locked FROM lms.user_credentials c WHERE c.user_id = p_user_id FOR UPDATE;
  IF (v_locked IS NOT NULL AND v_locked > now())
     OR EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = p_user_id)
     OR (p_require_mfa AND lms.mfa_required_here(p_user_id, p_tenant_id)) THEN
    RETURN QUERY SELECT 'denied'::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO s FROM lms.session_insert(p_user_id, p_tenant_id, p_session_id, p_token_hash, p_idle_seconds,
                                              p_absolute_seconds, p_ip, p_user_agent, NULL);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'denied'::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE lms.user_credentials c
     SET failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE c.user_id = p_user_id AND (c.failed_attempts <> 0 OR c.locked_until IS NOT NULL);

  IF p_tenant_id IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, p_user_id, 'auth.login_succeeded', 'session', p_session_id::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user_id, 'auth.login_succeeded', 'session', p_session_id::text, '{}'::jsonb, p_ip);
  END IF;

  RETURN QUERY SELECT 'ok'::text, s.r_email, s.r_display_name, s.r_role, s.r_expires_at;
END
$$;
REVOKE ALL ON FUNCTION lms.auth_login_complete(uuid, uuid, uuid, bytea, integer, integer, inet, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_login_complete(uuid, uuid, uuid, bytea, integer, integer, inet, text, uuid, boolean) TO lms_app;

-- The per-request lookup (return type changed: DROP + CREATE). While enforcement is on, an administrator's session that never passed
-- a second factor does not count: switching enforcement on needs no clean-up, and nothing that makes somebody an admin can slip past.
DROP FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer);
CREATE FUNCTION lms.auth_lookup_session(
  p_token_hash bytea, p_tenant_id uuid, p_touch_seconds integer, p_idle_seconds integer, p_require_mfa boolean DEFAULT false
)
RETURNS TABLE (
  session_id uuid, user_id uuid, tenant_id uuid, membership_role text,
  is_platform_admin boolean, email text, display_name text, mfa_verified_at timestamptz
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH hit AS (
    SELECT s.id AS session_id, s.user_id, s.tenant_id, s.last_seen_at, s.mfa_verified_at,
           m.role::text AS membership_role, u.is_platform_admin, u.email, u.display_name
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
  SELECT h.session_id, h.user_id, h.tenant_id, h.membership_role, h.is_platform_admin, h.email, h.display_name, h.mfa_verified_at
  FROM hit h
$$;
REVOKE ALL ON FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_lookup_session(bytea, uuid, integer, integer, boolean) TO lms_app;

-- ------------------------------------------------------------------ security mail of the second factor
-- Same function as 0052 with four more templates (CREATE OR REPLACE: signature, grants and owner stay).
CREATE OR REPLACE FUNCTION lms.email_enqueue_security(p_tenant uuid, p_user uuid, p_template text, p_params jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text;
  v_id uuid := lms.uuid_v7();
BEGIN
  IF p_template NOT IN ('invite', 'password_reset', 'password_changed', 'admin_promoted',
                        'mfa_enrol', 'mfa_enrolled', 'mfa_recovery_used', 'mfa_locked') THEN
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

-- ------------------------------------------------------------------ after a right password: a challenge, or the emailed link
-- Shared by both: the password verdict is re-read under the row lock (as auth_login_complete does), the person may sign in here,
-- and the password failures are cleared. false = no (the caller answers like a wrong password).
CREATE FUNCTION lms.mfa_password_accepted(p_user uuid, p_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_locked timestamptz;
BEGIN
  SELECT c.locked_until INTO v_locked FROM lms.user_credentials c WHERE c.user_id = p_user FOR UPDATE;
  IF NOT FOUND OR (v_locked IS NOT NULL AND v_locked > now()) THEN RETURN false; END IF;
  IF p_tenant IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id
                    WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active' AND t.status = 'active') THEN
      RETURN false;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin) THEN
    RETURN false;
  END IF;
  UPDATE lms.user_credentials c SET failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE c.user_id = p_user AND (c.failed_attempts <> 0 OR c.locked_until IS NOT NULL);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_password_accepted(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION lms.mfa_challenge_create(
  p_id uuid, p_token_hash bytea, p_user uuid, p_tenant uuid, p_ttl_seconds integer, p_ip inet, p_user_agent text,
  p_audit_id uuid, p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT lms.mfa_password_accepted(p_user, p_tenant) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = p_user) THEN RETURN false; END IF;
  INSERT INTO lms.auth_mfa_challenges (id, token_hash, user_id, tenant_id, purpose, ip, user_agent, created_at, expires_at)
  VALUES (p_id, p_token_hash, p_user, p_tenant, 'verify', p_ip, left(p_user_agent, 512), p_now,
          p_now + make_interval(secs => p_ttl_seconds));
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_challenged', '{}'::jsonb, p_ip);
  RETURN true;
END
$$;

CREATE FUNCTION lms.mfa_enrol_link_requested(p_user uuid, p_tenant uuid, p_key text, p_audit_id uuid, p_ip inet)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT lms.mfa_password_accepted(p_user, p_tenant) THEN RETURN false; END IF;
  IF NOT lms.mfa_required_here(p_user, p_tenant) OR EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = p_user) THEN
    RETURN false;
  END IF;
  PERFORM lms.email_enqueue_security(p_tenant, p_user, 'mfa_enrol', '{}'::jsonb, p_key);
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, p_user, 'auth.mfa_enrol_link_requested', '{}'::jsonb, p_ip);
  RETURN true;
END
$$;

-- ------------------------------------------------------------------ enrolment
-- Who the emailed token belongs to, while it can still be used (read only; the password is checked by the application).
CREATE FUNCTION lms.mfa_enrol_lookup(p_token_hash bytea, p_tenant uuid, p_now timestamptz)
RETURNS TABLE (r_user_id uuid, r_email text, r_password_hash text, r_locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT u.id, u.email, c.password_hash, c.locked_until
  FROM lms.auth_tokens a
  JOIN lms.users u ON u.id = a.user_id
  JOIN lms.user_credentials c ON c.user_id = a.user_id
  WHERE a.token_hash = p_token_hash AND a.purpose = 'mfa_enrol' AND a.used_at IS NULL AND a.expires_at > p_now
    AND a.tenant_id IS NOT DISTINCT FROM p_tenant
    AND lms.mfa_required_here(a.user_id, a.tenant_id)
    AND NOT EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = a.user_id)
$$;

CREATE FUNCTION lms.mfa_enrol_start(
  p_token_hash bytea, p_tenant uuid, p_id uuid, p_challenge_hash bytea, p_ciphertext bytea, p_nonce bytea, p_key_id text,
  p_ttl_seconds integer, p_ip inet, p_user_agent text, p_audit_id uuid, p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_token lms.auth_tokens%ROWTYPE;
BEGIN
  SELECT a.* INTO v_token FROM lms.auth_tokens a
   WHERE a.token_hash = p_token_hash AND a.purpose = 'mfa_enrol' AND a.used_at IS NULL AND a.expires_at > p_now
     AND a.tenant_id IS NOT DISTINCT FROM p_tenant;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT lms.mfa_password_accepted(v_token.user_id, p_tenant) THEN RETURN false; END IF;
  IF NOT lms.mfa_required_here(v_token.user_id, p_tenant)
     OR EXISTS (SELECT 1 FROM lms.user_mfa f WHERE f.user_id = v_token.user_id) THEN
    RETURN false;
  END IF;
  -- one enrolment at a time: an earlier page of the same person stops working
  UPDATE lms.auth_mfa_challenges c SET used_at = p_now
   WHERE c.user_id = v_token.user_id AND c.purpose = 'enrol' AND c.used_at IS NULL;
  INSERT INTO lms.auth_mfa_challenges
    (id, token_hash, user_id, tenant_id, purpose, enrol_token_id, pending_ciphertext, pending_nonce, pending_key_id,
     ip, user_agent, created_at, expires_at)
  VALUES (p_id, p_challenge_hash, v_token.user_id, p_tenant, 'enrol', v_token.id, p_ciphertext, p_nonce, p_key_id,
          p_ip, left(p_user_agent, 512), p_now, p_now + make_interval(secs => p_ttl_seconds));
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, v_token.user_id, 'auth.mfa_enrol_started', '{}'::jsonb, p_ip);
  RETURN true;
END
$$;

-- Charges one confirmation try and hands out the pending secret.
CREATE FUNCTION lms.mfa_enrol_attempt(
  p_challenge_hash bytea, p_tenant uuid, p_max integer, p_ip inet, p_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_ciphertext bytea, r_nonce bytea, r_key_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  c lms.auth_mfa_challenges%ROWTYPE;
BEGIN
  -- the lock order starts at user_credentials even where nothing there changes: the audit row below references users, which an
  -- account erasure holds (after user_credentials) while its trigger waits for these rows
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR NO KEY UPDATE;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash FOR UPDATE;
  IF NOT FOUND OR c.purpose <> 'enrol' OR c.used_at IS NOT NULL OR c.expires_at <= p_now
     OR c.tenant_id IS DISTINCT FROM p_tenant OR c.totp_attempts >= p_max THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::bytea, NULL::bytea, NULL::text;
    RETURN;
  END IF;
  UPDATE lms.auth_mfa_challenges x SET totp_attempts = x.totp_attempts + 1 WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, c.user_id, 'auth.mfa_attempt', jsonb_build_object('method', 'enrol'), p_ip);
  RETURN QUERY SELECT 'ok'::text, c.user_id, c.pending_ciphertext, c.pending_nonce, c.pending_key_id;
END
$$;

-- The code matched: the factor exists, with its recovery codes; every older session ends; this browser is signed in.
CREATE FUNCTION lms.mfa_enrol_complete(
  p_challenge_hash bytea, p_tenant uuid, p_step bigint, p_code_ids uuid[], p_code_hashes bytea[], p_code_key_id text,
  p_session_id uuid, p_session_hash bytea, p_idle_seconds integer, p_absolute_seconds integer, p_ip inet, p_user_agent text,
  p_audit_id uuid, p_login_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_email text, r_display_name text, r_role text, r_is_platform_admin boolean,
               r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  c lms.auth_mfa_challenges%ROWTYPE;
  s record;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR UPDATE;
  SELECT x.* INTO c FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash FOR UPDATE;
  IF NOT FOUND OR c.purpose <> 'enrol' OR c.used_at IS NOT NULL OR c.expires_at <= p_now OR c.tenant_id IS DISTINCT FROM p_tenant
     OR NOT lms.mfa_required_here(c.user_id, p_tenant) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  -- the emailed link is used up by THIS statement: a second confirmation, or an expired link, finds nothing
  UPDATE lms.auth_tokens a SET used_at = p_now WHERE a.id = c.enrol_token_id AND a.used_at IS NULL AND a.expires_at > p_now;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  INSERT INTO lms.user_mfa (user_id, secret_ciphertext, secret_nonce, key_id, enabled_at, last_used_step, updated_at)
  VALUES (c.user_id, c.pending_ciphertext, c.pending_nonce, c.pending_key_id, p_now, p_step, p_now)
  ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  INSERT INTO lms.user_mfa_recovery_codes (id, user_id, code_hash, key_id, created_at)
  SELECT p_code_ids[i], c.user_id, p_code_hashes[i], p_code_key_id, p_now FROM generate_subscripts(p_code_ids, 1) AS i;
  UPDATE lms.auth_mfa_challenges x SET used_at = p_now WHERE x.user_id = c.user_id AND x.used_at IS NULL;
  UPDATE lms.sessions x SET revoked_at = now() WHERE x.user_id = c.user_id AND x.revoked_at IS NULL;
  SELECT * INTO s FROM lms.session_insert(c.user_id, p_tenant, p_session_id, p_session_hash, p_idle_seconds,
                                              p_absolute_seconds, p_ip, p_user_agent, p_now);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the account may not sign in here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, c.user_id, 'auth.mfa_enrolled', '{}'::jsonb, p_ip);
  PERFORM lms.mfa_audit(p_login_audit_id, p_tenant, c.user_id, 'auth.login_succeeded', jsonb_build_object('mfa', 'enrol'), p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, c.user_id, 'mfa_enrolled', '{}'::jsonb, 'mfa-enrolled:' || p_audit_id);
  RETURN QUERY SELECT 'ok'::text, c.user_id, s.r_email, s.r_display_name, s.r_role, s.r_is_platform_admin, s.r_expires_at;
END
$$;

-- ------------------------------------------------------------------ sign-in with a code
-- Charges ONE TOTP attempt and only then hands out the encrypted secret. Lockout (ADR 0026): the 5th wrong code in a row locks for
-- 60 s doubling to 15 minutes; from the 20th in a row one try per 24 hours. A refused attempt is not counted. The lock that this
-- attempt sets is reported (audit + mail) when it is first HIT, so a right fifth code raises no false alarm.
CREATE FUNCTION lms.mfa_totp_attempt(
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
  v_failures integer;
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
  IF f.totp_locked_until IS NOT NULL AND f.totp_locked_until > p_now THEN
    IF NOT f.totp_lock_reported THEN
      UPDATE lms.user_mfa m SET totp_lock_reported = true, updated_at = p_now WHERE m.user_id = f.user_id;
      PERFORM lms.mfa_audit(p_lock_audit_id, p_tenant, f.user_id, 'auth.mfa_locked',
                            jsonb_build_object('method', 'totp', 'failedAttempts', f.totp_failures), p_ip);
      PERFORM lms.email_enqueue_security(p_tenant, f.user_id, 'mfa_locked', '{}'::jsonb, 'mfa-locked:' || p_lock_audit_id);
    END IF;
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::bytea, NULL::bytea, NULL::text,
                        ceil(extract(epoch FROM f.totp_locked_until - p_now))::integer;
    RETURN;
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
  UPDATE lms.auth_mfa_challenges x SET totp_attempts = x.totp_attempts + 1 WHERE x.id = c.id;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, f.user_id, 'auth.mfa_attempt', jsonb_build_object('method', 'totp'), p_ip);
  RETURN QUERY SELECT 'ok'::text, f.user_id, f.secret_ciphertext, f.secret_nonce, f.key_id, 0;
END
$$;

-- The code of time step p_step matched. Accepted only when that step is LATER than the last accepted one (replay, and two
-- simultaneous submissions of one code: the second waits on the row lock and sees the first one's step).
CREATE FUNCTION lms.mfa_totp_accept(
  p_challenge_hash bytea, p_tenant uuid, p_step bigint, p_session_id uuid, p_session_hash bytea, p_idle_seconds integer,
  p_absolute_seconds integer, p_ip inet, p_user_agent text, p_audit_id uuid, p_now timestamptz
)
RETURNS TABLE (r_status text, r_user_id uuid, r_email text, r_display_name text, r_role text, r_is_platform_admin boolean,
               r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
  f lms.user_mfa%ROWTYPE;
  c lms.auth_mfa_challenges%ROWTYPE;
  s record;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
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
  RETURN QUERY SELECT 'ok'::text, f.user_id, s.r_email, s.r_display_name, s.r_role, s.r_is_platform_admin, s.r_expires_at;
END
$$;

-- ------------------------------------------------------------------ sign-in with a recovery code: ONE statement
-- Its own counter and lock (a locked TOTP counter does not block it): the 5th wrong code in a row locks for 60 s, doubling, capped
-- at 15 minutes. p_hashes[i] is the code hashed with key p_key_ids[i] (every configured key).
CREATE FUNCTION lms.mfa_recovery_use(
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
  v_code uuid;
  v_remaining integer;
  v_failures integer;
  f lms.user_mfa%ROWTYPE;
  c lms.auth_mfa_challenges%ROWTYPE;
  s record;
BEGIN
  SELECT x.user_id INTO v_user FROM lms.auth_mfa_challenges x WHERE x.token_hash = p_challenge_hash;
  PERFORM 1 FROM lms.user_credentials uc WHERE uc.user_id = v_user FOR NO KEY UPDATE;
  SELECT m.* INTO f FROM lms.user_mfa m WHERE m.user_id = v_user FOR NO KEY UPDATE;
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
  IF f.recovery_locked_until IS NOT NULL AND f.recovery_locked_until > p_now THEN
    RETURN QUERY SELECT 'locked'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz,
                        ceil(extract(epoch FROM f.recovery_locked_until - p_now))::integer;
    RETURN;
  END IF;
  SELECT r.id INTO v_code
    FROM lms.user_mfa_recovery_codes r
    JOIN unnest(p_hashes, p_key_ids) AS g(hash, kid) ON g.hash = r.code_hash AND g.kid = r.key_id
   WHERE r.user_id = f.user_id AND r.used_at IS NULL
   LIMIT 1;

  UPDATE lms.auth_mfa_challenges x SET recovery_attempts = x.recovery_attempts + 1 WHERE x.id = c.id;
  IF v_code IS NULL THEN
    v_failures := f.recovery_failures + 1;
    UPDATE lms.user_mfa m
       SET recovery_failures = v_failures,
           recovery_locked_until = CASE WHEN v_failures >= 5
             THEN p_now + make_interval(secs => LEAST(900, 60 * power(2, LEAST(v_failures - 5, 20)))) END,
           updated_at = p_now
     WHERE m.user_id = f.user_id;
    PERFORM lms.mfa_audit(p_audit_id, p_tenant, f.user_id, 'auth.mfa_failed', jsonb_build_object('method', 'recovery'), p_ip);
    RETURN QUERY SELECT 'wrong'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;

  SELECT * INTO s FROM lms.session_insert(f.user_id, p_tenant, p_session_id, p_session_hash, p_idle_seconds,
                                              p_absolute_seconds, p_ip, p_user_agent, p_now);
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, 0;
    RETURN;
  END IF;
  UPDATE lms.user_mfa_recovery_codes r SET used_at = p_now WHERE r.id = v_code;
  -- a recovery code proves possession: both counters start again
  UPDATE lms.user_mfa m
     SET recovery_failures = 0, recovery_locked_until = NULL, totp_failures = 0, totp_locked_until = NULL,
         totp_lock_reported = false, updated_at = p_now
   WHERE m.user_id = f.user_id;
  UPDATE lms.auth_mfa_challenges x SET used_at = p_now WHERE x.id = c.id;
  SELECT count(*) INTO v_remaining FROM lms.user_mfa_recovery_codes r WHERE r.user_id = f.user_id AND r.used_at IS NULL;
  PERFORM lms.mfa_audit(p_audit_id, p_tenant, f.user_id, 'auth.mfa_recovery_used',
                        jsonb_build_object('remaining', v_remaining), p_ip);
  PERFORM lms.mfa_audit(p_login_audit_id, p_tenant, f.user_id, 'auth.login_succeeded', jsonb_build_object('mfa', 'recovery'), p_ip);
  PERFORM lms.email_enqueue_security(p_tenant, f.user_id, 'mfa_recovery_used',
                                     jsonb_build_object('remaining', v_remaining), 'mfa-recovery:' || p_audit_id);
  RETURN QUERY SELECT 'ok'::text, f.user_id, s.r_email, s.r_display_name, s.r_role, s.r_is_platform_admin, s.r_expires_at, 0;
END
$$;

-- ------------------------------------------------------------------ my status, clean-up, password reset / change
CREATE FUNCTION lms.mfa_status(p_user uuid)
RETURNS TABLE (r_enrolled_at timestamptz, r_recovery_remaining integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT m.enabled_at,
         (SELECT count(*)::integer FROM lms.user_mfa_recovery_codes r WHERE r.user_id = m.user_id AND r.used_at IS NULL)
  FROM (SELECT 1) one LEFT JOIN lms.user_mfa m ON m.user_id = p_user
$$;

CREATE FUNCTION lms.auth_purge_mfa_challenges(p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- a challenge holds an address and a user agent: gone a day after it expired
  WITH doomed AS (
    SELECT c.id FROM lms.auth_mfa_challenges c
    WHERE c.expires_at < now() - interval '1 day'
    LIMIT LEAST(GREATEST(p_batch, 1), 10000)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM lms.auth_mfa_challenges c USING doomed d WHERE c.id = d.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- A new password voids every open challenge (it was passed with the old one). A RESET also clears the second factor's counters
-- (the mailbox was proven); neither ever removes the factor. A trigger-free addition to the two existing functions:
CREATE OR REPLACE FUNCTION lms.auth_reset_password(
  p_token_hash bytea, p_password_hash text, p_tenant_id uuid, p_ip inet, p_audit_id uuid
)
RETURNS TABLE (r_user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  UPDATE lms.auth_tokens a SET used_at = now()
   WHERE a.token_hash = p_token_hash AND a.purpose = 'password_reset'
     AND a.used_at IS NULL AND a.expires_at > now()
  RETURNING a.user_id INTO v_user;
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  PERFORM lms.auth_set_password(v_user, p_password_hash);
  UPDATE lms.user_mfa m
     SET totp_failures = 0, totp_locked_until = NULL, totp_lock_reported = false, recovery_failures = 0,
         recovery_locked_until = NULL, updated_at = now()
   WHERE m.user_id = v_user;
  UPDATE lms.auth_mfa_challenges c SET used_at = now() WHERE c.user_id = v_user AND c.used_at IS NULL;
  UPDATE lms.sessions s SET revoked_at = now() WHERE s.user_id = v_user AND s.revoked_at IS NULL;
  IF p_tenant_id IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, v_user, 'auth.password_reset', 'user', v_user::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, v_user, 'auth.password_reset', 'user', v_user::text, '{}'::jsonb, p_ip);
  END IF;
  RETURN QUERY SELECT v_user;
END
$$;

CREATE OR REPLACE FUNCTION lms.auth_change_password(
  p_user_id uuid, p_password_hash text, p_except_session uuid, p_tenant_id uuid, p_ip inet, p_audit_id uuid
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM lms.auth_set_password(p_user_id, p_password_hash);
  UPDATE lms.auth_mfa_challenges c SET used_at = now() WHERE c.user_id = p_user_id AND c.used_at IS NULL;
  UPDATE lms.sessions s SET revoked_at = now()
   WHERE s.user_id = p_user_id AND s.revoked_at IS NULL AND s.id <> p_except_session;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF p_tenant_id IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, p_user_id, 'auth.password_changed', 'user', p_user_id::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user_id, 'auth.password_changed', 'user', p_user_id::text, '{}'::jsonb, p_ip);
  END IF;
  RETURN v_n;
END
$$;

-- ------------------------------------------------------------------ existing administrator sessions end here
-- They were made with a password alone. Owner only (the migration and nothing else); audited in the same statement.
CREATE FUNCTION lms.mfa_revoke_admin_sessions(p_audit_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.sessions s SET revoked_at = now()
   WHERE s.revoked_at IS NULL
     AND (s.tenant_id IS NULL
          OR EXISTS (SELECT 1 FROM lms.tenant_memberships m
                      WHERE m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.role = 'institution_admin'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, NULL, 'auth.admin_sessions_revoked', 'session', NULL, jsonb_build_object('sessions', v_n));
  END IF;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION lms.mfa_revoke_admin_sessions(uuid) FROM PUBLIC;
SELECT lms.mfa_revoke_admin_sessions(lms.uuid_v7());

-- ------------------------------------------------------------------ privileges of the new functions
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace
      AND p.proname IN ('mfa_challenge_create', 'mfa_enrol_link_requested', 'mfa_enrol_lookup', 'mfa_enrol_start',
                        'mfa_enrol_attempt', 'mfa_enrol_complete', 'mfa_totp_attempt', 'mfa_totp_accept', 'mfa_recovery_use',
                        'mfa_status', 'auth_purge_mfa_challenges')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

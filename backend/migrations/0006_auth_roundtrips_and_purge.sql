-- Step 2b: fewer database round trips + bounded cleanup.
-- Forward-only: 0005 stays as it is; the functions below are ADDED. Same hardening as 0005:
-- SECURITY DEFINER, owner-owned, SET search_path = lms, pg_temp, EXECUTE only for lms_app.

-- ---------------------------------------------------------------- login: step 1 (one statement)
-- Everything the service needs before it can verify the password, in ONE round trip:
-- tenant status (fresh, not cached), the account + credentials, and the membership in that tenant.
-- Always returns exactly one row so an unknown email costs the same as a known one.
CREATE FUNCTION lms.auth_login_begin(p_email text, p_tenant_id uuid)
RETURNS TABLE (
  r_user_id uuid, r_password_hash text, r_locked_until timestamptz, r_is_platform_admin boolean,
  r_tenant_active boolean, r_membership_role text, r_membership_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT u.id, c.password_hash, c.locked_until, u.is_platform_admin,
         (t.status = 'active'), m.role::text, m.status::text
  FROM (SELECT 1) one
  LEFT JOIN lms.tenants t ON t.id = p_tenant_id
  LEFT JOIN lms.users u ON u.email = lower(btrim(p_email))
  LEFT JOIN lms.user_credentials c ON c.user_id = u.id
  LEFT JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant_id AND m.user_id = u.id
$$;

-- ---------------------------------------------------------------- login: step 2 (success)
-- After the password verified: re-validates membership/tenant status, clears failed attempts,
-- creates the session and writes the audit entry - one statement, one round trip. The caller
-- passes the ids and the token HASH (the token itself never reaches the database).
CREATE FUNCTION lms.auth_login_complete(
  p_user_id uuid, p_tenant_id uuid, p_session_id uuid, p_token_hash bytea,
  p_idle_seconds integer, p_absolute_seconds integer, p_ip inet, p_user_agent text,
  p_audit_id uuid
)
RETURNS TABLE (r_status text, r_email text, r_display_name text, r_role text, r_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text;
  v_name text;
  v_admin boolean;
  v_role text;
  v_abs timestamptz := now() + make_interval(secs => p_absolute_seconds);
  v_idle timestamptz := LEAST(now() + make_interval(secs => p_idle_seconds), v_abs);
BEGIN
  SELECT u.email, u.display_name, u.is_platform_admin INTO v_email, v_name, v_admin
  FROM lms.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'denied'::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_tenant_id IS NOT NULL THEN
    SELECT m.role::text INTO v_role
    FROM lms.tenant_memberships m JOIN lms.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id
      AND m.status = 'active' AND t.status = 'active';
    IF v_role IS NULL THEN
      RETURN QUERY SELECT 'denied'::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  ELSIF NOT v_admin THEN
    RETURN QUERY SELECT 'denied'::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE lms.user_credentials c
     SET failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE c.user_id = p_user_id AND (c.failed_attempts <> 0 OR c.locked_until IS NOT NULL);

  INSERT INTO lms.sessions
    (id, token_hash, user_id, tenant_id, idle_expires_at, absolute_expires_at, ip, user_agent)
  VALUES
    (p_session_id, p_token_hash, p_user_id, p_tenant_id, v_idle, v_abs, p_ip, left(p_user_agent, 512));

  IF p_tenant_id IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, p_user_id, 'auth.login_succeeded', 'session', p_session_id::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user_id, 'auth.login_succeeded', 'session', p_session_id::text, '{}'::jsonb, p_ip);
  END IF;

  RETURN QUERY SELECT 'ok'::text, v_email, v_name, v_role, v_abs;
END
$$;

-- ---------------------------------------------------------------- login: failure (one statement)
-- Counts a wrong password (only when p_count; attempts while locked are ignored), and writes the
-- audit entries: auth.login_failed, plus auth.account_locked when this failure locked the account.
CREATE FUNCTION lms.auth_login_failed(
  p_user_id uuid, p_tenant_id uuid, p_count boolean, p_reason text,
  p_max_attempts integer, p_base_seconds integer, p_max_seconds integer,
  p_ip inet, p_audit_id uuid, p_lock_audit_id uuid
)
RETURNS TABLE (r_failed_attempts integer, r_just_locked boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_attempts integer := 0;
  v_locked boolean := false;
  v_meta jsonb := jsonb_build_object('reason', p_reason)
                  || CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END;
BEGIN
  IF p_count THEN
    SELECT f.failed_attempts, f.just_locked INTO v_attempts, v_locked
    FROM lms.auth_record_login_failure(p_user_id, p_max_attempts, p_base_seconds, p_max_seconds) f;
    v_attempts := COALESCE(v_attempts, 0);
    v_locked := COALESCE(v_locked, false);
  END IF;

  IF p_tenant_id IS NOT NULL THEN
    IF v_locked THEN
      INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (p_lock_audit_id, p_tenant_id, p_user_id, 'auth.account_locked', 'user', p_user_id::text,
              v_meta || jsonb_build_object('failedAttempts', v_attempts));
    END IF;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, p_user_id, 'auth.login_failed', 'user', p_user_id::text, v_meta);
  ELSE
    IF v_locked THEN
      INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
      VALUES (p_lock_audit_id, p_user_id, 'auth.account_locked', 'user', p_user_id::text,
              v_meta || jsonb_build_object('failedAttempts', v_attempts), p_ip);
    END IF;
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user_id, 'auth.login_failed', 'user', p_user_id::text, v_meta, p_ip);
  END IF;
  RETURN QUERY SELECT v_attempts, v_locked;
END
$$;

-- ---------------------------------------------------------------- logout (one statement)
-- Revokes the caller's session and writes the audit entry. Authorisation: the session must belong
-- to p_user_id (and tenant); a session id that is not theirs revokes nothing.
CREATE FUNCTION lms.auth_logout(p_session_id uuid, p_user_id uuid, p_tenant_id uuid, p_ip inet, p_audit_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.sessions s SET revoked_at = now()
   WHERE s.id = p_session_id AND s.user_id = p_user_id
     AND s.tenant_id IS NOT DISTINCT FROM p_tenant_id AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN false;
  END IF;
  IF p_tenant_id IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant_id, p_user_id, 'auth.logout', 'session', p_session_id::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user_id, 'auth.logout', 'session', p_session_id::text, '{}'::jsonb, p_ip);
  END IF;
  RETURN true;
END
$$;


-- ---------------------------------------------------------------- password reset / change (one statement each)
-- Redeems the reset token, sets the password (clearing any lock), revokes EVERY session of the user and
-- writes the audit entry atomically: no half-finished reset if the process dies in between.
CREATE FUNCTION lms.auth_reset_password(
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

-- Caller has already verified the current password. Sets the new one, revokes the user's OTHER
-- sessions and audits, in one statement. Returns how many sessions were revoked.
CREATE FUNCTION lms.auth_change_password(
  p_user_id uuid, p_password_hash text, p_except_session uuid, p_tenant_id uuid, p_ip inet, p_audit_id uuid
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM lms.auth_set_password(p_user_id, p_password_hash);
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

-- ---------------------------------------------------------------- bounded purge
-- lms_app has no DELETE on these tables: cleanup goes through these functions. Each call deletes at
-- most p_batch rows (so no long locks) and returns how many it deleted; the caller loops.
CREATE INDEX sessions_idle_expires_idx ON lms.sessions (idle_expires_at);
CREATE INDEX sessions_absolute_expires_idx ON lms.sessions (absolute_expires_at);
CREATE INDEX sessions_revoked_idx ON lms.sessions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX auth_tokens_expires_idx ON lms.auth_tokens (expires_at);
CREATE INDEX auth_tokens_used_idx ON lms.auth_tokens (used_at) WHERE used_at IS NOT NULL;

CREATE FUNCTION lms.auth_purge_sessions(p_retention_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_retention_days);
  v_n integer;
BEGIN
  WITH doomed AS (
    SELECT s.id FROM lms.sessions s
    WHERE s.revoked_at < v_cutoff OR s.idle_expires_at < v_cutoff OR s.absolute_expires_at < v_cutoff
    LIMIT LEAST(GREATEST(p_batch, 1), 10000)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM lms.sessions s USING doomed d WHERE s.id = d.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

CREATE FUNCTION lms.auth_purge_tokens(p_retention_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_retention_days);
  v_n integer;
BEGIN
  WITH doomed AS (
    SELECT a.id FROM lms.auth_tokens a
    WHERE a.used_at < v_cutoff OR a.expires_at < v_cutoff
    LIMIT LEAST(GREATEST(p_batch, 1), 10000)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM lms.auth_tokens a USING doomed d WHERE a.id = d.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- ---------------------------------------------------------------- privileges (same loop as 0005)
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace
      AND p.proname IN ('auth_login_begin', 'auth_login_complete', 'auth_login_failed', 'auth_logout',
                        'auth_purge_sessions', 'auth_purge_tokens', 'auth_reset_password', 'auth_change_password')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

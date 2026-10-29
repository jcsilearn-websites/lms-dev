-- Step 2: SECURITY DEFINER functions. The ONLY way lms_app can touch credentials, tokens and the
-- platform audit log, and the only way to look things up before a tenant context exists.
-- Hardening applied to every function:
--   * owned by the migration (owner) role, SET search_path = lms, pg_temp, objects schema-qualified
--   * EXECUTE revoked from PUBLIC (and therefore anon/authenticated) and granted to lms_app only
--   * narrow, documented return columns

-- ---------------------------------------------------------------- tenant resolution (pre-tenant)
CREATE FUNCTION lms.auth_resolve_tenant(p_slug text)
RETURNS TABLE (id uuid, slug text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT t.id, t.slug, t.status::text FROM lms.tenants t WHERE t.slug = p_slug
$$;

-- ---------------------------------------------------------------- login lookup (pre-tenant)
CREATE FUNCTION lms.auth_find_login(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, locked_until timestamptz, is_platform_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT u.id, c.password_hash, c.locked_until, u.is_platform_admin
  FROM lms.users u
  JOIN lms.user_credentials c ON c.user_id = u.id
  WHERE u.email = lower(btrim(p_email))
$$;

-- Counts a failed attempt. Attempts made while the account is locked are NOT counted, so an
-- attacker cannot keep a victim locked out by hammering the endpoint. From the N-th failure the
-- lock is base * 2^(n-N) seconds, capped at p_max_seconds.
CREATE FUNCTION lms.auth_record_login_failure(
  p_user_id uuid, p_max_attempts integer, p_base_seconds integer, p_max_seconds integer
)
RETURNS TABLE (failed_attempts integer, locked_until timestamptz, just_locked boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_attempts integer;
  v_prev_lock timestamptz;
  v_lock timestamptz;
  v_just boolean := false;
BEGIN
  SELECT c.failed_attempts, c.locked_until INTO v_attempts, v_prev_lock
  FROM lms.user_credentials c WHERE c.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_prev_lock IS NOT NULL AND v_prev_lock > now() THEN
    RETURN QUERY SELECT v_attempts, v_prev_lock, false;
    RETURN;
  END IF;

  v_attempts := v_attempts + 1;
  v_lock := NULL;
  IF v_attempts >= p_max_attempts THEN
    v_lock := now() + make_interval(
      secs => LEAST(
        p_max_seconds::double precision,
        p_base_seconds * power(2, LEAST(v_attempts - p_max_attempts, 20))
      )
    );
    v_just := true;
  END IF;
  UPDATE lms.user_credentials c
     SET failed_attempts = v_attempts, locked_until = v_lock, updated_at = now()
   WHERE c.user_id = p_user_id;
  RETURN QUERY SELECT v_attempts, v_lock, v_just;
END
$$;

CREATE FUNCTION lms.auth_clear_failures(p_user_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  UPDATE lms.user_credentials
     SET failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE user_id = p_user_id AND (failed_attempts <> 0 OR locked_until IS NOT NULL)
$$;

-- Sets (or creates) the password and clears any lock.
CREATE FUNCTION lms.auth_set_password(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  INSERT INTO lms.user_credentials (user_id, password_hash)
  VALUES (p_user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_updated_at = now(),
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = now()
$$;

-- ---------------------------------------------------------------- sessions (pre-tenant lookup)
-- ONE statement: finds the live session, joins the user and the membership role, enforces expiry,
-- revocation, tenant match, ACTIVE membership and ACTIVE tenant (so suspending a tenant takes effect
-- on the very next request), and bumps last_seen/idle expiry at most once per p_touch_seconds.
CREATE FUNCTION lms.auth_lookup_session(
  p_token_hash bytea, p_tenant_id uuid, p_touch_seconds integer, p_idle_seconds integer
)
RETURNS TABLE (
  session_id uuid, user_id uuid, tenant_id uuid, membership_role text,
  is_platform_admin boolean, email text, display_name text
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH hit AS (
    SELECT s.id AS session_id, s.user_id, s.tenant_id, s.last_seen_at,
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
  ),
  touch AS (
    UPDATE lms.sessions s
       SET last_seen_at = now(),
           idle_expires_at = LEAST(now() + make_interval(secs => p_idle_seconds), s.absolute_expires_at)
     WHERE s.id = (SELECT session_id FROM hit)
       AND s.last_seen_at < now() - make_interval(secs => p_touch_seconds)
    RETURNING s.id
  )
  SELECT h.session_id, h.user_id, h.tenant_id, h.membership_role, h.is_platform_admin, h.email, h.display_name
  FROM hit h
$$;

-- Revokes a user's sessions: all tenants when p_tenant_id IS NULL, optionally keeping one session.
CREATE FUNCTION lms.auth_revoke_user_sessions(p_user_id uuid, p_except_session uuid, p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE lms.sessions s
     SET revoked_at = now()
   WHERE s.user_id = p_user_id
     AND s.revoked_at IS NULL
     AND (p_except_session IS NULL OR s.id <> p_except_session)
     AND (p_tenant_id IS NULL OR s.tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------- users / tokens / invites
-- Returns the user id for the email, creating the user (with the app-generated UUIDv7) if missing.
CREATE FUNCTION lms.auth_ensure_user(p_new_id uuid, p_email text, p_display_name text)
RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_id uuid;
BEGIN
  INSERT INTO lms.users AS u (id, email, display_name)
  VALUES (p_new_id, v_email, p_display_name)
  ON CONFLICT (email) DO NOTHING
  RETURNING u.id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
  ELSE
    RETURN QUERY SELECT u.id, false FROM lms.users u WHERE u.email = v_email;
  END IF;
END
$$;

-- Creates a single-use token and invalidates earlier unused tokens of the same kind.
CREATE FUNCTION lms.auth_create_token(
  p_id uuid, p_purpose text, p_token_hash bytea, p_user_id uuid,
  p_tenant_id uuid, p_membership_id uuid, p_ttl_seconds integer, p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.auth_tokens a
     SET used_at = now()
   WHERE a.user_id = p_user_id
     AND a.purpose = p_purpose::lms.auth_token_purpose
     AND a.used_at IS NULL
     AND a.tenant_id IS NOT DISTINCT FROM p_tenant_id;
  INSERT INTO lms.auth_tokens
    (id, purpose, token_hash, user_id, tenant_id, membership_id, created_by_user_id, expires_at)
  VALUES
    (p_id, p_purpose::lms.auth_token_purpose, p_token_hash, p_user_id, p_tenant_id, p_membership_id,
     p_created_by, now() + make_interval(secs => p_ttl_seconds));
  RETURN p_id;
END
$$;

-- Atomically redeems a password-reset token (single use, unexpired).
CREATE FUNCTION lms.auth_consume_reset_token(p_token_hash bytea)
RETURNS TABLE (user_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  UPDATE lms.auth_tokens a
     SET used_at = now()
   WHERE a.token_hash = p_token_hash
     AND a.purpose = 'password_reset'
     AND a.used_at IS NULL
     AND a.expires_at > now()
  RETURNING a.user_id
$$;

-- Atomically accepts an invite: redeems the token, sets the initial password when the user has
-- none, activates the membership. Returns a status: ok | invalid | password_required.
CREATE FUNCTION lms.auth_accept_invite(p_token_hash bytea, p_expected_tenant uuid, p_password_hash text)
RETURNS TABLE (r_status text, r_user_id uuid, r_tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_tok lms.auth_tokens%ROWTYPE;
  v_has_password boolean;
BEGIN
  SELECT a.* INTO v_tok
  FROM lms.auth_tokens a
  JOIN lms.tenants t ON t.id = a.tenant_id AND t.status = 'active'
  WHERE a.token_hash = p_token_hash
    AND a.purpose = 'invite'
    AND a.used_at IS NULL
    AND a.expires_at > now()
    AND (p_expected_tenant IS NULL OR a.tenant_id = p_expected_tenant)
  FOR UPDATE OF a;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  v_has_password := EXISTS (SELECT 1 FROM lms.user_credentials c WHERE c.user_id = v_tok.user_id);
  IF NOT v_has_password AND p_password_hash IS NULL THEN
    RETURN QUERY SELECT 'password_required'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF NOT v_has_password THEN
    INSERT INTO lms.user_credentials (user_id, password_hash) VALUES (v_tok.user_id, p_password_hash);
  END IF;

  UPDATE lms.tenant_memberships m
     SET status = 'active', updated_at = now()
   WHERE m.tenant_id = v_tok.tenant_id AND m.id = v_tok.membership_id;
  UPDATE lms.auth_tokens a SET used_at = now() WHERE a.id = v_tok.id;
  RETURN QUERY SELECT 'ok'::text, v_tok.user_id, v_tok.tenant_id;
END
$$;

-- ---------------------------------------------------------------- platform audit
CREATE FUNCTION lms.auth_audit_platform(
  p_id uuid, p_actor uuid, p_action text, p_target_type text, p_target_id text,
  p_metadata jsonb, p_ip inet
)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_id, p_actor, p_action, p_target_type, p_target_id, COALESCE(p_metadata, '{}'::jsonb), p_ip)
$$;

-- ---------------------------------------------------------------- privileges
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'auth\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

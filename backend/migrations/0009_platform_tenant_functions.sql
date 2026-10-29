-- Step 4: platform-admin tenant management.
-- lms_app can only SELECT the current tenant (RLS) and has no privilege on platform_audit_log, so the
-- admin-host operations are narrow SECURITY DEFINER functions with the same hardening as 0005/0006:
-- owner-owned, SET search_path = lms, pg_temp, schema-qualified, EXECUTE revoked from PUBLIC and
-- granted to lms_app only. Every function re-checks that p_actor IS a platform admin (defence in
-- depth: the application checks it too) and raises insufficient_privilege (42501) otherwise.

-- Invariant fix: accepting an invite may only activate a PENDING membership (a suspended member who
-- still holds an old token must stay suspended). CREATE OR REPLACE of the 0005 function.
CREATE OR REPLACE FUNCTION lms.auth_accept_invite(p_token_hash bytea, p_expected_tenant uuid, p_password_hash text)
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
  JOIN lms.tenant_memberships pm ON pm.tenant_id = a.tenant_id AND pm.id = a.membership_id
                                AND pm.status = 'pending'
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

-- ---------------------------------------------------------------- invite an institution admin
-- Used by "create tenant" and by POST /platform/tenants/:id/admin-invite. Status:
--   invited   new or pending membership, an invite token was issued (older unused ones are void)
--   promoted  the user was already an ACTIVE member: now institution_admin, sessions revoked, no token
--   already_admin / suspended / tenant_not_found: nothing changed
-- Writes the platform audit entry AND the tenant's audit entry in the same statement.
CREATE FUNCTION lms.platform_admin_invite(
  p_actor uuid, p_tenant_id uuid, p_new_user_id uuid, p_email text, p_display_name text,
  p_membership_id uuid, p_token_id uuid, p_token_hash bytea, p_ttl_seconds integer,
  p_audit_id uuid, p_ip inet
)
RETURNS TABLE (r_status text, r_user_id uuid, r_membership_id uuid, r_slug text, r_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_slug text;
  v_name text;
  v_user_id uuid;
  v_m lms.tenant_memberships%ROWTYPE;
  v_status text;
  v_meta jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  SELECT t.slug, t.name INTO v_slug, v_name FROM lms.tenants t WHERE t.id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'tenant_not_found'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO lms.users AS u (id, email, display_name) VALUES (p_new_user_id, v_email, p_display_name)
  ON CONFLICT (email) DO NOTHING;
  SELECT u.id INTO v_user_id FROM lms.users u WHERE u.email = v_email;

  SELECT m.* INTO v_m FROM lms.tenant_memberships m
   WHERE m.tenant_id = p_tenant_id AND m.user_id = v_user_id FOR UPDATE;
  IF FOUND THEN
    IF v_m.status = 'suspended' THEN
      RETURN QUERY SELECT 'suspended'::text, v_user_id, v_m.id, v_slug, v_name;
      RETURN;
    ELSIF v_m.status = 'active' AND v_m.role = 'institution_admin' THEN
      RETURN QUERY SELECT 'already_admin'::text, v_user_id, v_m.id, v_slug, v_name;
      RETURN;
    ELSIF v_m.status = 'active' THEN
      UPDATE lms.tenant_memberships m SET role = 'institution_admin', updated_at = now() WHERE m.id = v_m.id;
      UPDATE lms.sessions s SET revoked_at = now()
       WHERE s.user_id = v_user_id AND s.tenant_id = p_tenant_id AND s.revoked_at IS NULL;
      v_status := 'promoted';
    ELSE
      UPDATE lms.tenant_memberships m SET role = 'institution_admin', updated_at = now() WHERE m.id = v_m.id;
      v_status := 'invited';
    END IF;
  ELSE
    INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
    VALUES (p_membership_id, p_tenant_id, v_user_id, 'institution_admin', 'pending')
    RETURNING * INTO v_m;
    v_status := 'invited';
  END IF;

  IF v_status = 'invited' THEN
    PERFORM lms.auth_create_token(p_token_id, 'invite', p_token_hash, v_user_id, p_tenant_id, v_m.id,
                                  p_ttl_seconds, p_actor);
  END IF;

  v_meta := jsonb_build_object('email', v_email, 'outcome', v_status, 'tenantSlug', v_slug);
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, 'platform.tenant_admin_invited', 'tenant', p_tenant_id::text, v_meta, p_ip);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_audit_id, p_tenant_id, p_actor, 'platform.tenant_admin_invited', 'membership', v_m.id::text,
          v_meta || jsonb_build_object('viaPlatformAdmin', true, 'userId', v_user_id));
  RETURN QUERY SELECT v_status, v_user_id, v_m.id, v_slug, v_name;
END
$$;

-- ---------------------------------------------------------------- create a tenant + invite its first admin
-- One statement = one transaction: the tenant, the pending admin membership and the invite token exist
-- together or not at all. Slug rules (reserved words, format) are the table's CHECK constraints.
CREATE FUNCTION lms.platform_create_tenant(
  p_actor uuid, p_tenant_id uuid, p_slug text, p_name text,
  p_new_user_id uuid, p_admin_email text, p_admin_name text,
  p_membership_id uuid, p_token_id uuid, p_token_hash bytea, p_ttl_seconds integer,
  p_audit_id uuid, p_invite_audit_id uuid, p_ip inet
)
RETURNS TABLE (r_user_id uuid, r_membership_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_membership_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO lms.tenants (id, slug, name, status) VALUES (p_tenant_id, p_slug, p_name, 'active');
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, 'platform.tenant_created', 'tenant', p_tenant_id::text,
          jsonb_build_object('slug', p_slug, 'name', p_name), p_ip);
  SELECT i.r_user_id, i.r_membership_id INTO v_user_id, v_membership_id
    FROM lms.platform_admin_invite(p_actor, p_tenant_id, p_new_user_id, p_admin_email, p_admin_name,
                                   p_membership_id, p_token_id, p_token_hash, p_ttl_seconds,
                                   p_invite_audit_id, p_ip) i;
  RETURN QUERY SELECT v_user_id, v_membership_id;
END
$$;

-- ---------------------------------------------------------------- read
CREATE FUNCTION lms.platform_list_tenants(p_actor uuid, p_pattern text, p_after uuid, p_limit integer)
RETURNS TABLE (r_id uuid, r_slug text, r_name text, r_status text, r_created_at timestamptz, r_updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.id, t.slug, t.name, t.status::text, t.created_at, t.updated_at
      FROM lms.tenants t
     WHERE (p_after IS NULL OR t.id > p_after)
       AND (p_pattern IS NULL
            OR lower(t.name) LIKE lower(p_pattern) ESCAPE '\'
            OR t.slug LIKE lower(p_pattern) ESCAPE '\')
     ORDER BY t.id
     LIMIT LEAST(GREATEST(p_limit, 1), 1001);
END
$$;

CREATE FUNCTION lms.platform_get_tenant(p_actor uuid, p_id uuid)
RETURNS TABLE (
  r_id uuid, r_slug text, r_name text, r_status text, r_created_at timestamptz, r_updated_at timestamptz,
  r_members integer, r_active_admins integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.id, t.slug, t.name, t.status::text, t.created_at, t.updated_at,
           (SELECT count(*)::integer FROM lms.tenant_memberships m WHERE m.tenant_id = t.id),
           (SELECT count(*)::integer FROM lms.tenant_memberships m
             WHERE m.tenant_id = t.id AND m.role = 'institution_admin' AND m.status = 'active')
      FROM lms.tenants t WHERE t.id = p_id;
END
$$;

-- ---------------------------------------------------------------- update / suspend / reactivate
CREATE FUNCTION lms.platform_update_tenant(p_actor uuid, p_id uuid, p_name text, p_audit_id uuid, p_ip inet)
RETURNS TABLE (r_id uuid, r_slug text, r_name text, r_status text, r_created_at timestamptz, r_updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_old lms.tenants%ROWTYPE;
  v_meta jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  SELECT t.* INTO v_old FROM lms.tenants t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE lms.tenants t SET name = p_name, updated_at = now() WHERE t.id = p_id;
  v_meta := jsonb_build_object('before', jsonb_build_object('name', v_old.name),
                               'after', jsonb_build_object('name', p_name));
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, 'platform.tenant_updated', 'tenant', p_id::text, v_meta, p_ip);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_audit_id, p_id, p_actor, 'platform.tenant_updated', 'tenant', p_id::text,
          v_meta || '{"viaPlatformAdmin": true}'::jsonb);
  RETURN QUERY
    SELECT t.id, t.slug, t.name, t.status::text, t.created_at, t.updated_at FROM lms.tenants t WHERE t.id = p_id;
END
$$;

-- Idempotent: setting the status a tenant already has changes nothing and writes no audit entry.
CREATE FUNCTION lms.platform_set_tenant_status(p_actor uuid, p_id uuid, p_status text, p_audit_id uuid, p_ip inet)
RETURNS TABLE (
  r_id uuid, r_slug text, r_name text, r_status text, r_created_at timestamptz, r_updated_at timestamptz,
  r_changed boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_old lms.tenants%ROWTYPE;
  v_action text;
  v_meta jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid tenant status' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_old FROM lms.tenants t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_old.status::text = p_status THEN
    RETURN QUERY SELECT v_old.id, v_old.slug, v_old.name, v_old.status::text, v_old.created_at,
                        v_old.updated_at, false;
    RETURN;
  END IF;
  UPDATE lms.tenants t SET status = p_status::lms.tenant_status, updated_at = now() WHERE t.id = p_id;
  v_action := CASE p_status WHEN 'suspended' THEN 'platform.tenant_suspended' ELSE 'platform.tenant_reactivated' END;
  v_meta := jsonb_build_object('before', jsonb_build_object('status', v_old.status),
                               'after', jsonb_build_object('status', p_status));
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, v_action, 'tenant', p_id::text, v_meta, p_ip);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_audit_id, p_id, p_actor, v_action, 'tenant', p_id::text, v_meta || '{"viaPlatformAdmin": true}'::jsonb);
  RETURN QUERY
    SELECT t.id, t.slug, t.name, t.status::text, t.created_at, t.updated_at, true FROM lms.tenants t WHERE t.id = p_id;
END
$$;

-- ---------------------------------------------------------------- platform audit log (read)
-- Newest first, keyset on (created_at, id). r_cursor_at is created_at as exact UTC text with
-- microseconds, to be echoed back inside the opaque cursor.
CREATE FUNCTION lms.platform_list_audit(
  p_actor uuid, p_action text, p_from timestamptz, p_to timestamptz,
  p_after_at timestamptz, p_after_id uuid, p_limit integer
)
RETURNS TABLE (
  r_id uuid, r_actor_user_id uuid, r_action text, r_target_type text, r_target_id text,
  r_metadata jsonb, r_created_at timestamptz, r_cursor_at text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.actor_user_id, a.action, a.target_type, a.target_id, a.metadata, a.created_at,
           to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM lms.platform_audit_log a
     WHERE (p_action IS NULL OR a.action = p_action)
       AND (p_from IS NULL OR a.created_at >= p_from)
       AND (p_to IS NULL OR a.created_at < p_to)
       AND (p_after_at IS NULL OR (a.created_at, a.id) < (p_after_at, p_after_id))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 1001);
END
$$;

-- ---------------------------------------------------------------- privileges
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'platform\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

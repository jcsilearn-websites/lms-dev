-- Step 6b: soft removal of members. The app never hard-deletes a membership (academic history hangs off it).

-- 1. History tables never cascade from memberships: RESTRICT (a membership with history cannot be deleted at all).
ALTER TABLE lms.course_participants DROP CONSTRAINT course_participants_membership_fk;
ALTER TABLE lms.course_participants ADD CONSTRAINT course_participants_membership_fk
  FOREIGN KEY (tenant_id, membership_id) REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE lms.member_profiles DROP CONSTRAINT member_profiles_membership_fk;
ALTER TABLE lms.member_profiles ADD CONSTRAINT member_profiles_membership_fk
  FOREIGN KEY (tenant_id, membership_id) REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE RESTRICT;
-- (sessions and invite tokens still cascade: they are not history)

-- 2. lms_app cannot delete memberships any more: removing a member is UPDATE ... SET status = 'removed'.
REVOKE DELETE ON lms.tenant_memberships FROM lms_app;

-- 3. a participant who lost access because the MEMBERSHIP was removed (comes back with it)
ALTER TABLE lms.course_participants DROP CONSTRAINT course_participants_removed_reason_check;
ALTER TABLE lms.course_participants ADD CONSTRAINT course_participants_removed_reason_check
  CHECK (removed_reason IN ('manual', 'sync', 'membership'));

-- 4. the platform admin invite brings a REMOVED membership back as pending (same row)
CREATE OR REPLACE FUNCTION lms.platform_admin_invite(
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
      -- pending (re-invite) or REMOVED: the SAME membership comes back as a pending admin, history stays attached
      UPDATE lms.tenant_memberships m SET role = 'institution_admin', status = 'pending', updated_at = now()
       WHERE m.id = v_m.id;
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

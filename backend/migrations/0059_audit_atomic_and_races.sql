-- Two bug classes found by CI, swept across the whole code base.
--
-- CLASS A: a state change and its audit row in two transactions (a connection lost in between leaves a change nobody can see
-- in the audit log). The invite creation was fixed in 9434be9; the same shape was left in three auth flows, now done in ONE
-- statement each (the audit insert is inside the definer function, like auth_reset_password / auth_change_password already do):
--   auth_accept_invite_audited      accept an invite + 'auth.invite_accepted'
--   auth_unlock_user                clear a lockout + 'auth.account_unlocked'
--   auth_password_reset_requested   queue the reset email + 'auth.password_reset_requested'
--
-- CLASS B: check, then act, with a different snapshot in between (assessment_start, 0057). The sweep found:
--   auth_accept_invite              joined the membership with status = 'pending' in its SELECT, then activated it WITHOUT looking at
--                                   the status again: an admin who suspended the member in between had the suspension undone by the
--                                   accept. The UPDATE now carries the condition (single-statement check and act).
--   auth_login_complete             took the lockout verdict from the read made before the (slow) password check. It now re-reads the
--                                   credential row FOR UPDATE: a lock that a concurrent failure just set is honoured.
--   platform_admin_invite           looked for the membership, found none, then INSERTed: two simultaneous first invites of the same
--                                   person made the second fail with a unique violation (500). Now the upsert loop: INSERT ... ON
--                                   CONFLICT DO NOTHING, and look again when someone else won.
--   assignment_upload_begin         counted the learner's draft files, then inserted one (the cap could be passed by simultaneous
--                                   calls) and checked "already submitted" without excluding a hand-in in flight. It takes the SAME
--                                   per-learner advisory lock as assignment_submit.
-- Every function keeps its signature (CREATE OR REPLACE): grants and owner stay.

-- ------------------------------------------------------------------ auth_accept_invite: the activation is conditional
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

  -- the status is decided HERE, by the row the UPDATE locks: a member suspended or removed since the SELECT above stays so
  UPDATE lms.tenant_memberships m
     SET status = 'active', updated_at = now()
   WHERE m.tenant_id = v_tok.tenant_id AND m.id = v_tok.membership_id AND m.status = 'pending';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF NOT v_has_password THEN
    INSERT INTO lms.user_credentials (user_id, password_hash) VALUES (v_tok.user_id, p_password_hash);
  END IF;
  UPDATE lms.auth_tokens a SET used_at = now() WHERE a.id = v_tok.id;
  RETURN QUERY SELECT 'ok'::text, v_tok.user_id, v_tok.tenant_id;
END
$$;

-- ------------------------------------------------------------------ class A: accept an invite + its audit row, one statement
CREATE FUNCTION lms.auth_accept_invite_audited(
  p_token_hash bytea, p_expected_tenant uuid, p_password_hash text, p_audit_id uuid, p_ip inet
)
RETURNS TABLE (r_status text, r_user_id uuid, r_tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM lms.auth_accept_invite(p_token_hash, p_expected_tenant, p_password_hash);
  IF v.r_status = 'ok' THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, v.r_tenant_id, v.r_user_id, 'auth.invite_accepted', 'user', v.r_user_id::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  END IF;
  RETURN QUERY SELECT v.r_status, v.r_user_id, v.r_tenant_id;
END
$$;

-- ------------------------------------------------------------------ class A: unlock + its audit row, one statement
-- p_tenant NULL = the admin host (platform_audit_log).
CREATE FUNCTION lms.auth_unlock_user(p_user uuid, p_tenant uuid, p_actor uuid, p_audit_id uuid, p_ip inet)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM lms.auth_clear_failures(p_user);
  IF p_tenant IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant, p_actor, 'auth.account_unlocked', 'user', p_user::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_actor, 'auth.account_unlocked', 'user', p_user::text, '{}'::jsonb, p_ip);
  END IF;
END
$$;

-- ------------------------------------------------------------------ class A: reset request = the queued email + its audit row
-- Returns whether a mail was queued (false: suppressed address, unknown member, the same key again). The audit row is written
-- either way the mail is decided, in the same statement.
CREATE FUNCTION lms.auth_password_reset_requested(p_user uuid, p_tenant uuid, p_key text, p_audit_id uuid, p_ip inet)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_queued boolean;
BEGIN
  v_queued := lms.email_enqueue_security(p_tenant, p_user, 'password_reset', '{}'::jsonb, p_key);
  IF p_tenant IS NOT NULL THEN
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_audit_id, p_tenant, p_user, 'auth.password_reset_requested', 'user', p_user::text,
            CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  ELSE
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
    VALUES (p_audit_id, p_user, 'auth.password_reset_requested', 'user', p_user::text, '{}'::jsonb, p_ip);
  END IF;
  RETURN v_queued;
END
$$;

REVOKE ALL ON FUNCTION lms.auth_accept_invite_audited(bytea, uuid, text, uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_accept_invite_audited(bytea, uuid, text, uuid, inet) TO lms_app;
REVOKE ALL ON FUNCTION lms.auth_unlock_user(uuid, uuid, uuid, uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_unlock_user(uuid, uuid, uuid, uuid, inet) TO lms_app;
REVOKE ALL ON FUNCTION lms.auth_password_reset_requested(uuid, uuid, text, uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.auth_password_reset_requested(uuid, uuid, text, uuid, inet) TO lms_app;

-- ------------------------------------------------------------------ auth_login_complete: the lockout is re-read under the row lock
CREATE OR REPLACE FUNCTION lms.auth_login_complete(
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
  v_locked timestamptz;
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

  -- The service decided "not locked" from a read made BEFORE the password check (tens of milliseconds of argon2). Failures recorded
  -- since then may have locked the account: read it again under the row lock (waits for a failure being recorded right now).
  SELECT c.locked_until INTO v_locked FROM lms.user_credentials c WHERE c.user_id = p_user_id FOR UPDATE;
  IF v_locked IS NOT NULL AND v_locked > now() THEN
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

-- ------------------------------------------------------------------ platform_admin_invite: the upsert loop
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

  LOOP
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
      EXIT;
    END IF;
    -- none yet: create it; when another transaction created it since (the unique key (tenant, user) decides), look again
    INSERT INTO lms.tenant_memberships (id, tenant_id, user_id, role, status)
    VALUES (p_membership_id, p_tenant_id, v_user_id, 'institution_admin', 'pending')
    ON CONFLICT (tenant_id, user_id) DO NOTHING
    RETURNING * INTO v_m;
    IF FOUND THEN
      v_status := 'invited';
      EXIT;
    END IF;
  END LOOP;

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

-- ------------------------------------------------------------------ assignment_upload_begin: serialised with the hand-in
CREATE OR REPLACE FUNCTION lms.assignment_upload_begin(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid,
                                                       p_storage_key text, p_name text, p_content_type text, p_size bigint,
                                                       p_grace integer, p_arrival timestamptz DEFAULT NULL,
                                                       p_max_age integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  t record;
  drafts integer;
  arr timestamptz := lms.effective_arrival(p_arrival, p_max_age);
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN jsonb_build_object('result', g.verdict); END IF;
  IF g.kind <> 'assignment' THEN RETURN jsonb_build_object('result', 'not_visible'); END IF;
  -- the SAME key as assignment_submit: one writer at a time per learner and assignment. Everything below (settings, "already
  -- submitted", the draft count) is read AFTER the lock, so it describes the state this call is about to change.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_item::text || g.participant_id::text, 10));
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  IF NOT a.allow_file THEN RETURN jsonb_build_object('result', 'files_not_allowed'); END IF;
  IF p_size > a.max_file_mb::bigint * 1048576 THEN
    RETURN jsonb_build_object('result', 'file_too_large', 'maxMb', a.max_file_mb);
  END IF;
  IF a.opens_at IS NOT NULL AND arr < a.opens_at THEN RETURN jsonb_build_object('result', 'not_open'); END IF;
  SELECT * INTO t FROM lms.assignment_timing(p_tenant, p_item, g.participant_id);
  IF t.due IS NOT NULL AND arr > t.cutoff THEN RETURN jsonb_build_object('result', 'closed'); END IF;
  IF NOT a.resubmission_allowed AND EXISTS (
       SELECT 1 FROM lms.submissions s
        WHERE s.tenant_id = p_tenant AND s.assignment_item_id = p_item AND s.participant_id = g.participant_id) THEN
    RETURN jsonb_build_object('result', 'already_submitted');
  END IF;
  SELECT count(*) INTO drafts FROM lms.assignment_uploads u
   WHERE u.tenant_id = p_tenant AND u.assignment_item_id = p_item AND u.participant_id = g.participant_id;
  -- a few spare slots so replacing a file does not need a clean-up first; the abuse stays bounded
  IF drafts >= a.max_files + 5 THEN RETURN jsonb_build_object('result', 'too_many_files'); END IF;

  INSERT INTO lms.files (id, tenant_id, storage_key, original_name, content_type, declared_size, created_by)
  VALUES (p_file, p_tenant, p_storage_key, p_name, p_content_type, p_size, p_user);
  INSERT INTO lms.assignment_uploads (tenant_id, file_id, assignment_item_id, participant_id, created_at)
  VALUES (p_tenant, p_file, p_item, g.participant_id, arr);
  RETURN jsonb_build_object('result', 'ok', 'maxMb', a.max_file_mb, 'maxFiles', a.max_files);
END
$$;

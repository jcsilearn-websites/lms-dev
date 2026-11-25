-- Step 14b-1, part 4b: ACCOUNT-LEVEL ERASURE, the functions (the tables and guards are migration 0066).
--
-- Two ways in, both end in ONE execution (`privacy_account_execute`):
--   combined  a member of exactly ONE college asks (password re-entry done by the application): the request is the college request of
--             part 3 (the college's administrators approve it, 7 days of grace, cancel until then) plus an account request that WAITS for it.
--             When the college erasure is done the account request becomes due; a cancel / rejection / expiry of the college request ends it too.
--   platform  a person with no active membership anywhere cannot sign in, so a platform administrator files the request for them and a
--             DIFFERENT platform administrator approves it (7 days of grace, either can cancel, an undecided request expires after 30 days).
--
-- Execution (one transaction): per-person advisory lock -> the request row -> the person's memberships (by id) -> the credentials -> the user row
-- (the order every other path uses: membership -> user in the guard trigger, credentials -> user in login) -> re-check that no membership is
-- left that is not removed -> `privacy_erase_core` for every college where the person had a membership that was not erased yet (this is what keeps
-- the audit scrub the ONLY way past the append-only trigger) -> the account: credentials deleted, sessions revoked and wiped, tokens deleted,
-- the row pseudonymised, the plain address of the suppressions dropped (the keyed hash stays) -> platform audit trail scrubbed (allowlist only).
-- Nothing of a college's academic record is touched: the rows keep pointing at the same ids, they are shown under the pseudonym.
--
-- Every state change and its audit row are written by the same function. Every function takes p_now.

-- ---------------------------------------------------------------- shapes (internal)
CREATE FUNCTION lms.privacy_account_json(r lms.account_erasure_requests)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', r.id, 'status', r.status, 'source', r.source, 'requestedAt', r.requested_at, 'expiresAt', r.expires_at,
                            'graceUntil', r.grace_until)
$$;
REVOKE ALL ON FUNCTION lms.privacy_account_json(lms.account_erasure_requests) FROM PUBLIC;

-- the number of memberships of the person that are not removed (the eligibility rule)
CREATE FUNCTION lms.privacy_account_live_memberships(p_user uuid)
RETURNS integer
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT count(*)::integer FROM lms.tenant_memberships m WHERE m.user_id = p_user AND m.status <> 'removed'
$$;
REVOKE ALL ON FUNCTION lms.privacy_account_live_memberships(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------- the member's view (tenant host): the latest account request + eligibility
CREATE FUNCTION lms.privacy_account_mine(p_tenant uuid, p_user uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object(
    'request', (SELECT lms.privacy_account_json(r) FROM lms.account_erasure_requests r WHERE r.user_id = p_user
                 ORDER BY r.requested_at DESC, r.id DESC LIMIT 1),
    -- eligible for the combined request: this is the person's ONLY college (one membership that is not removed), and not a platform admin
    'eligible', (lms.privacy_account_live_memberships(p_user) = 1
                 AND EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active')
                 AND NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin)),
    'colleges', lms.privacy_account_live_memberships(p_user))
$$;

-- ---------------------------------------------------------------- combined request (member of exactly one college)
CREATE FUNCTION lms.privacy_account_request_combined(p_tenant uuid, p_user uuid, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_open lms.account_erasure_requests;
  v_college jsonb;
  v_college_id uuid;
  v_id uuid;
  v_row lms.account_erasure_requests;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || p_user::text, 0));
  IF EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.is_platform_admin) THEN RETURN jsonb_build_object('result', 'not_eligible'); END IF;
  IF lms.privacy_account_live_memberships(p_user) <> 1
     OR NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active') THEN
    RETURN jsonb_build_object('result', 'not_eligible');
  END IF;
  SELECT * INTO v_open FROM lms.account_erasure_requests r
   WHERE r.user_id = p_user AND r.status IN ('waiting_college', 'pending_approval', 'approved', 'executing');
  IF FOUND THEN RETURN jsonb_build_object('result', 'in_progress', 'request', lms.privacy_account_json(v_open)); END IF;
  -- the college half (its own checks: one open request, the last administrator, the audit row, the notice to the administrators)
  v_college := lms.privacy_erasure_request(p_tenant, p_user, p_ip, p_now);
  IF v_college ->> 'result' <> 'ok' THEN RETURN v_college; END IF;
  v_college_id := (v_college -> 'request' ->> 'id')::uuid;
  UPDATE lms.erasure_requests SET with_account = true WHERE id = v_college_id;
  v_id := lms.uuid_v7();
  INSERT INTO lms.account_erasure_requests (id, user_id, source, status, college_request_id, requested_at, requested_by, expires_at)
  VALUES (v_id, p_user, 'member_combined', 'waiting_college', v_college_id, p_now, p_user, p_now + interval '30 days');
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_user, 'privacy.account_erasure_requested', 'account_erasure_request', v_id::text, '{}'::jsonb);
  SELECT * INTO v_row FROM lms.account_erasure_requests r WHERE r.id = v_id;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_account_json(v_row), 'collegeRequest', v_college -> 'request');
END
$$;

-- ---------------------------------------------------------------- platform path: file, approve | reject | cancel, list
CREATE FUNCTION lms.privacy_account_platform_request(p_actor uuid, p_email text, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_user lms.users;
  v_id uuid;
  v_open lms.account_erasure_requests;
  v_row lms.account_erasure_requests;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users a WHERE a.id = p_actor AND a.is_platform_admin) THEN
    RAISE EXCEPTION 'the actor is not a platform administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_user FROM lms.users u WHERE u.email = lower(btrim(p_email));
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || v_user.id::text, 0));
  IF v_user.erased_at IS NOT NULL THEN RETURN jsonb_build_object('result', 'already_erased'); END IF;
  IF v_user.is_platform_admin THEN RETURN jsonb_build_object('result', 'is_platform_admin'); END IF;
  IF lms.privacy_account_live_memberships(v_user.id) > 0 THEN
    RETURN jsonb_build_object('result', 'has_memberships', 'count', lms.privacy_account_live_memberships(v_user.id));
  END IF;
  SELECT * INTO v_open FROM lms.account_erasure_requests r
   WHERE r.user_id = v_user.id AND r.status IN ('waiting_college', 'pending_approval', 'approved', 'executing');
  IF FOUND THEN RETURN jsonb_build_object('result', 'in_progress', 'request', lms.privacy_account_json(v_open)); END IF;
  v_id := lms.uuid_v7();
  INSERT INTO lms.account_erasure_requests (id, user_id, source, status, requested_at, requested_by, expires_at)
  VALUES (v_id, v_user.id, 'platform', 'pending_approval', p_now, p_actor, p_now + interval '30 days');
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (lms.uuid_v7(), p_actor, 'privacy.account_erasure_requested', 'account_erasure_request', v_id::text,
          jsonb_build_object('userId', v_user.id), p_ip);
  SELECT * INTO v_row FROM lms.account_erasure_requests r WHERE r.id = v_id;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_account_json(v_row));
END
$$;

CREATE FUNCTION lms.privacy_account_platform_decide(p_actor uuid, p_id uuid, p_action text, p_now timestamptz, p_ip inet)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.account_erasure_requests;
  v_grace timestamptz;
  v_status text;
BEGIN
  IF p_action NOT IN ('approve', 'reject', 'cancel') THEN RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.users a WHERE a.id = p_actor AND a.is_platform_admin) THEN
    RAISE EXCEPTION 'the actor is not a platform administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM lms.account_erasure_requests e WHERE e.id = p_id AND e.source = 'platform' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF p_action = 'cancel' THEN
    IF r.status NOT IN ('pending_approval', 'approved') OR (r.status = 'approved' AND p_now >= r.grace_until) THEN
      RETURN jsonb_build_object('result', 'too_late', 'status', r.status);
    END IF;
    v_status := 'cancelled';
  ELSE
    IF p_actor = r.requested_by THEN RETURN jsonb_build_object('result', 'self_approval'); END IF;
    IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('result', 'not_pending', 'status', r.status); END IF;
    IF p_now >= r.expires_at THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    v_status := CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END;
  END IF;
  IF v_status = 'approved' THEN
    IF lms.privacy_account_live_memberships(r.user_id) > 0 THEN RETURN jsonb_build_object('result', 'has_memberships'); END IF;
    v_grace := p_now + interval '7 days';
    UPDATE lms.account_erasure_requests SET status = 'approved', approved_at = p_now, approved_by = p_actor, grace_until = v_grace,
           decided_at = p_now, decided_by = p_actor WHERE id = p_id;
  ELSE
    UPDATE lms.account_erasure_requests SET status = v_status, decided_at = p_now, decided_by = p_actor WHERE id = p_id;
  END IF;
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (lms.uuid_v7(), p_actor, 'privacy.account_erasure_' || v_status, 'account_erasure_request', p_id::text,
          jsonb_build_object('userId', r.user_id) || CASE WHEN v_grace IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('graceUntil', v_grace) END, p_ip);
  SELECT * INTO r FROM lms.account_erasure_requests e WHERE e.id = p_id;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_account_json(r));
END
$$;

-- keyset list (newest first) for the platform administrators; the person is shown as they are stored (an erased account: the pseudonym)
CREATE FUNCTION lms.privacy_account_platform_list(p_actor uuid, p_limit integer, p_after_at timestamptz, p_after_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users a WHERE a.id = p_actor AND a.is_platform_admin) THEN
    RAISE EXCEPTION 'the actor is not a platform administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (
    WITH page AS (
      SELECT r.* FROM lms.account_erasure_requests r
       WHERE r.source = 'platform' AND (p_after_at IS NULL OR (r.requested_at, r.id) < (p_after_at, p_after_id))
       ORDER BY r.requested_at DESC, r.id DESC LIMIT v_limit + 1)
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'id', p.id, 'status', p.status, 'source', p.source, 'requestedAt', p.requested_at, 'expiresAt', p.expires_at,
                  'graceUntil', p.grace_until, 'executedAt', p.executed_at,
                  'requestedByName', (SELECT a.display_name FROM lms.users a WHERE a.id = p.requested_by),
                  'approvedByName', (SELECT a.display_name FROM lms.users a WHERE a.id = p.approved_by),
                  'personName', (SELECT u.display_name FROM lms.users u WHERE u.id = p.user_id),
                  'personEmail', (SELECT u.email FROM lms.users u WHERE u.id = p.user_id AND u.erased_at IS NULL),
                  'erased', (SELECT u.erased_at IS NOT NULL FROM lms.users u WHERE u.id = p.user_id),
                  'canApprove', p.status = 'pending_approval' AND p.requested_by IS DISTINCT FROM p_actor,
                  'canCancel', p.status = 'pending_approval' OR p.status = 'approved') ORDER BY p.requested_at DESC, p.id DESC)
                  FROM (SELECT * FROM page ORDER BY requested_at DESC, id DESC LIMIT v_limit) p), '[]'::jsonb),
      'hasMore', (SELECT count(*) > v_limit FROM page))
  );
END
$$;

-- ---------------------------------------------------------------- the scheduled sync (worker): expiry, and the combined requests follow their college half
CREATE FUNCTION lms.privacy_account_sync(p_now timestamptz, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.account_erasure_requests;
  c lms.erasure_requests;
  v_limit integer := least(greatest(p_limit, 1), 500);
  v_expired integer := 0;
  v_ready integer := 0;
  v_closed integer := 0;
BEGIN
  -- an undecided platform request expires after 30 days
  FOR r IN SELECT * FROM lms.account_erasure_requests e WHERE e.status = 'pending_approval' AND e.expires_at <= p_now
            ORDER BY e.expires_at, e.id LIMIT v_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE lms.account_erasure_requests SET status = 'expired', decided_at = p_now WHERE id = r.id;
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), NULL, 'privacy.account_erasure_expired', 'account_erasure_request', r.id::text, jsonb_build_object('userId', r.user_id));
    v_expired := v_expired + 1;
  END LOOP;
  -- a combined request follows its college half
  FOR r IN SELECT * FROM lms.account_erasure_requests e WHERE e.status = 'waiting_college'
            ORDER BY e.requested_at, e.id LIMIT v_limit FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO c FROM lms.erasure_requests q WHERE q.id = r.college_request_id;
    IF c.status = 'done' THEN
      UPDATE lms.account_erasure_requests SET status = 'approved', approved_at = p_now, grace_until = p_now WHERE id = r.id;
      INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (lms.uuid_v7(), c.tenant_id, NULL, 'privacy.account_erasure_ready', 'account_erasure_request', r.id::text, '{}'::jsonb);
      v_ready := v_ready + 1;
    ELSIF c.status IN ('cancelled', 'rejected', 'expired') THEN
      UPDATE lms.account_erasure_requests SET status = c.status, decided_at = p_now WHERE id = r.id;
      INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (lms.uuid_v7(), c.tenant_id, NULL, 'privacy.account_erasure_' || c.status, 'account_erasure_request', r.id::text, '{}'::jsonb);
      v_closed := v_closed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('expired', v_expired, 'ready', v_ready, 'closed', v_closed);
END
$$;

-- ---------------------------------------------------------------- the worker: due, the address, the execution
CREATE FUNCTION lms.privacy_account_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (r_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT e.id FROM lms.account_erasure_requests e
   WHERE e.status = 'approved' AND e.grace_until <= p_now
   ORDER BY e.grace_until, e.id LIMIT least(greatest(p_limit, 1), 200)
$$;

CREATE FUNCTION lms.privacy_account_prepare(p_id uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT coalesce((SELECT jsonb_build_object('result', 'ok', 'email', u.email)
                     FROM lms.account_erasure_requests e JOIN lms.users u ON u.id = e.user_id
                    WHERE e.id = p_id AND e.status = 'approved' AND e.grace_until <= p_now AND u.erased_at IS NULL),
                  jsonb_build_object('result', 'not_due'))
$$;

-- The erasure itself (internal). The caller holds the person lock, the request row FOR UPDATE (status executing) and the row locks of the
-- membership / credentials / user rows, taken in that order.
CREATE FUNCTION lms.privacy_account_erase_core(p_request uuid, p_now timestamptz, p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.account_erasure_requests;
  m record;
  v_req uuid;
  v_counts jsonb;
  v_colleges integer := 0;
  v_out jsonb := '{}'::jsonb;
  n integer;
BEGIN
  SELECT * INTO r FROM lms.account_erasure_requests e WHERE e.id = p_request AND e.status = 'executing';
  IF NOT FOUND THEN RAISE EXCEPTION 'the request is not executing' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- 1 every college where the person had a membership that was not erased yet (all of them are removed by now): the same core as the
  --   college erasure, through an internal request of that college (the audit scrub works only inside an EXECUTING request)
  FOR m IN SELECT mm.tenant_id, mm.id AS membership_id FROM lms.tenant_memberships mm
            WHERE mm.user_id = r.user_id
              AND NOT EXISTS (SELECT 1 FROM lms.membership_display_overrides o WHERE o.tenant_id = mm.tenant_id AND o.membership_id = mm.id)
            ORDER BY mm.tenant_id, mm.id
  LOOP
    UPDATE lms.erasure_requests SET status = 'cancelled', decided_at = p_now
     WHERE tenant_id = m.tenant_id AND membership_id = m.membership_id AND status IN ('pending_approval', 'approved', 'executing');
    v_req := lms.uuid_v7();
    INSERT INTO lms.erasure_requests (id, tenant_id, membership_id, user_id, status, source, requested_at, grace_until, executed_at)
    VALUES (v_req, m.tenant_id, m.membership_id, r.user_id, 'executing', 'account', p_now, p_now, p_now);
    v_counts := lms.privacy_erase_core(m.tenant_id, v_req, p_email, p_hash, p_kid);
    UPDATE lms.erasure_requests SET status = 'done', ledger_at = p_now WHERE id = v_req;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), m.tenant_id, NULL, 'privacy.erasure_executed', 'erasure_request', v_req::text, v_counts);
    v_colleges := v_colleges + 1;
  END LOOP;
  v_out := v_out || jsonb_build_object('collegesErased', v_colleges);
  -- 2 the account: no way to sign in, no session, no token
  DELETE FROM lms.user_credentials WHERE user_id = r.user_id;
  v_out := v_out || jsonb_build_object('sessionsRevoked', lms.auth_revoke_user_sessions(r.user_id, NULL, NULL));
  UPDATE lms.sessions SET ip = NULL, user_agent = NULL WHERE user_id = r.user_id;
  DELETE FROM lms.auth_tokens WHERE user_id = r.user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('tokensDeleted', n);
  -- 3 the global row: a random pseudonym and an address that cannot receive mail and is free for a new account of the same person
  UPDATE lms.users
     SET display_name = 'Former user ' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
         email = 'erased-' || replace(id::text, '-', '') || '@erased.invalid',
         erased_at = p_now, updated_at = now()
   WHERE id = r.user_id;
  -- 4 the platform audit trail: the allowlisted keys of the rows about the person, and the address they acted from
  UPDATE lms.platform_audit_log a SET metadata = lms.audit_scrub_metadata(a.metadata)
   WHERE (a.actor_user_id = r.user_id OR a.target_id = r.user_id::text OR a.metadata ->> 'userId' = r.user_id::text
          OR lower(a.metadata ->> 'email') = lower(p_email))
     AND a.metadata IS DISTINCT FROM lms.audit_scrub_metadata(a.metadata);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE lms.platform_audit_log SET ip = NULL WHERE actor_user_id = r.user_id AND ip IS NOT NULL;
  v_out := v_out || jsonb_build_object('platformAuditRowsScrubbed', n);
  -- 5 the plain address of the suppressions goes, the keyed hash stays
  v_out := v_out || jsonb_build_object('suppressionsSealed', lms.privacy_suppression_seal(p_email, p_hash, p_kid, true));
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION lms.privacy_account_erase_core(uuid, timestamptz, text, bytea, text) FROM PUBLIC;

-- takes the locks in the fixed order; returns false when the person is already erased or missing
CREATE FUNCTION lms.privacy_account_lock(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = lms, pg_temp
AS $$
BEGIN
  -- NO KEY UPDATE, not UPDATE: a session insert (login) checks its membership with FOR KEY SHARE, which UPDATE would block while the login
  -- holds the credentials row we wait for next (a deadlock the held-lock test found; CLAUDE.md: a lock on a parent row is FOR NO KEY UPDATE)
  PERFORM 1 FROM lms.tenant_memberships m WHERE m.user_id = p_user ORDER BY m.id FOR NO KEY UPDATE;
  PERFORM 1 FROM lms.user_credentials c WHERE c.user_id = p_user FOR UPDATE;
  PERFORM 1 FROM lms.users u WHERE u.id = p_user FOR UPDATE;
  RETURN EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.erased_at IS NULL);
END
$$;
REVOKE ALL ON FUNCTION lms.privacy_account_lock(uuid) FROM PUBLIC;

CREATE FUNCTION lms.privacy_account_execute(p_id uuid, p_now timestamptz, p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.account_erasure_requests;
  v_user uuid;
  v_counts jsonb;
BEGIN
  SELECT e.user_id INTO v_user FROM lms.account_erasure_requests e WHERE e.id = p_id;
  IF v_user IS NULL THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || v_user::text, 0));
  SELECT * INTO r FROM lms.account_erasure_requests e WHERE e.id = p_id FOR UPDATE;
  IF r.status <> 'approved' THEN RETURN jsonb_build_object('result', 'skip', 'status', r.status); END IF;
  IF p_now < r.grace_until THEN RETURN jsonb_build_object('result', 'not_due'); END IF;
  IF NOT lms.privacy_account_lock(r.user_id) THEN
    UPDATE lms.account_erasure_requests SET status = 'cancelled', decided_at = p_now, reason = 'already_erased' WHERE id = p_id;
    RETURN jsonb_build_object('result', 'blocked', 'reason', 'already_erased');
  END IF;
  -- decided AFTER the locks: a membership created or activated meanwhile is seen here (or was refused by the guard)
  IF lms.privacy_account_live_memberships(r.user_id) > 0 OR EXISTS (SELECT 1 FROM lms.users u WHERE u.id = r.user_id AND u.is_platform_admin) THEN
    UPDATE lms.account_erasure_requests SET status = 'rejected', decided_at = p_now, reason = 'has_membership' WHERE id = p_id;
    INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), NULL, 'privacy.account_erasure_blocked', 'account_erasure_request', p_id::text,
            jsonb_build_object('userId', r.user_id, 'reason', 'has_membership'));
    RETURN jsonb_build_object('result', 'blocked', 'reason', 'has_membership');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = r.user_id AND u.email = lower(p_email)) THEN
    RETURN jsonb_build_object('result', 'retry');
  END IF;
  UPDATE lms.account_erasure_requests SET status = 'executing' WHERE id = p_id;
  v_counts := lms.privacy_account_erase_core(p_id, p_now, p_email, p_hash, p_kid);
  UPDATE lms.account_erasure_requests SET status = 'done', executed_at = p_now WHERE id = p_id;
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), NULL, 'privacy.account_erasure_executed', 'account_erasure_request', p_id::text, v_counts);
  RETURN jsonb_build_object('result', 'ok', 'userId', r.user_id, 'counts', v_counts);
END
$$;

-- ---------------------------------------------------------------- the ledger (ids only)
CREATE FUNCTION lms.privacy_account_ledger_pending(p_limit integer)
RETURNS TABLE (r_id uuid, r_user uuid, r_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT e.id, e.user_id, e.executed_at FROM lms.account_erasure_requests e
   WHERE e.status = 'done' AND e.ledger_at IS NULL ORDER BY e.executed_at, e.id LIMIT least(greatest(p_limit, 1), 500)
$$;

CREATE FUNCTION lms.privacy_account_ledger_done(p_ids uuid[], p_now timestamptz)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH u AS (UPDATE lms.account_erasure_requests SET ledger_at = p_now WHERE id = ANY (p_ids) AND status = 'done' AND ledger_at IS NULL RETURNING 1)
  SELECT count(*)::integer FROM u
$$;

-- After a RESTORE of an older backup: the account is erased again from the ledger (ids only)
CREATE FUNCTION lms.privacy_account_reapply_prepare(p_user uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT coalesce((SELECT CASE WHEN u.erased_at IS NOT NULL THEN jsonb_build_object('result', 'already')
                               ELSE jsonb_build_object('result', 'ok', 'email', u.email) END
                     FROM lms.users u WHERE u.id = p_user),
                  jsonb_build_object('result', 'nothing_to_do'))
$$;

CREATE FUNCTION lms.privacy_account_reapply(p_user uuid, p_request uuid, p_at timestamptz, p_now timestamptz, p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_counts jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || p_user::text, 0));
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user) THEN RETURN jsonb_build_object('result', 'nothing_to_do'); END IF;
  IF NOT lms.privacy_account_lock(p_user) THEN RETURN jsonb_build_object('result', 'already'); END IF;
  -- the college erasures of the same person come first in the ledger (and are re-applied first): a membership that is still live is not
  -- ours to remove, the next run of the command will find it done
  IF lms.privacy_account_live_memberships(p_user) > 0 THEN RETURN jsonb_build_object('result', 'has_membership'); END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.email = lower(p_email)) THEN
    RETURN jsonb_build_object('result', 'nothing_to_do');
  END IF;
  IF EXISTS (SELECT 1 FROM lms.account_erasure_requests e WHERE e.id = p_request) THEN
    UPDATE lms.account_erasure_requests SET status = 'executing', grace_until = coalesce(grace_until, p_at) WHERE id = p_request AND user_id = p_user;
  ELSE
    UPDATE lms.account_erasure_requests SET status = 'cancelled', decided_at = p_now
     WHERE user_id = p_user AND status IN ('waiting_college', 'pending_approval', 'approved', 'executing');
    INSERT INTO lms.account_erasure_requests (id, user_id, source, status, requested_at, executed_at)
    VALUES (p_request, p_user, 'ledger', 'executing', p_at, p_at);
  END IF;
  v_counts := lms.privacy_account_erase_core(p_request, p_now, p_email, p_hash, p_kid);
  UPDATE lms.account_erasure_requests SET status = 'done', executed_at = coalesce(executed_at, p_at), ledger_at = p_now WHERE id = p_request;
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), NULL, 'privacy.account_erasure_reapplied', 'account_erasure_request', p_request::text, v_counts);
  RETURN jsonb_build_object('result', 'ok', 'counts', v_counts);
END
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'privacy_account_mine(uuid, uuid)',
    'privacy_account_request_combined(uuid, uuid, inet, timestamptz)',
    'privacy_account_platform_request(uuid, text, inet, timestamptz)',
    'privacy_account_platform_decide(uuid, uuid, text, timestamptz, inet)',
    'privacy_account_platform_list(uuid, integer, timestamptz, uuid)',
    'privacy_account_sync(timestamptz, integer)',
    'privacy_account_due(timestamptz, integer)',
    'privacy_account_prepare(uuid, timestamptz)',
    'privacy_account_execute(uuid, timestamptz, text, bytea, text)',
    'privacy_account_ledger_pending(integer)',
    'privacy_account_ledger_done(uuid[], timestamptz)',
    'privacy_account_reapply_prepare(uuid)',
    'privacy_account_reapply(uuid, uuid, timestamptz, timestamptz, text, bytea, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

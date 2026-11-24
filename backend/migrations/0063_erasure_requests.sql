-- Step 14b-1, part 3a: ERASURE INSIDE A COLLEGE, the request side (the execution is migration 0064).
--
-- A member asks to be erased from ONE college (the global account and every other college are untouched). The request needs their
-- password again (done by the application before it calls here), a college administrator approves it (never the same person), a 7-day
-- grace period starts at the approval, and either of them can cancel until it ends. An unapproved request expires after 30 days and
-- the member is told (in the bell and by e-mail). The last active institution admin of a college cannot be erased: refused at the
-- request, at the approval and again at the execution.
--
--   erasure_requests             one row per request; lms_app can only SELECT; every change is one of the functions below
--   privacy_erasure_preview      counts only: what will be removed and what is kept (the numbers, never a value)
--   privacy_erasure_request      request (+ audit row + a notice to the administrators): ONE call
--   privacy_erasure_decide       approve | reject | cancel (+ audit row + a notice to the member): ONE call
--   privacy_erasure_expire       the scheduled expiry of requests nobody decided on (+ audit row + notice to the member)
--
-- Every state change and its audit row are written by the same function (one transaction). Every function takes p_now.
-- States: pending_approval -> approved -> executing -> done;  pending_approval | approved -> cancelled;  pending_approval -> rejected | expired.

CREATE TABLE lms.erasure_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  membership_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES lms.users (id),
  status text NOT NULL CHECK (status IN ('pending_approval', 'approved', 'executing', 'done', 'cancelled', 'rejected', 'expired')),
  -- 'member' = asked by the member; 'ledger' = re-applied from the erasure ledger after a restore (migration 0064)
  source text NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'ledger')),
  requested_at timestamptz NOT NULL,
  -- an undecided request ends here (30 days)
  expires_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES lms.users (id),
  -- the execution may not start before this instant, a cancel is refused from this instant on
  grace_until timestamptz,
  decided_at timestamptz,
  decided_by uuid REFERENCES lms.users (id),
  -- a generic code for a refusal made by the system (last_admin), never a value
  reason text CHECK (length(reason) <= 60),
  executed_at timestamptz,
  -- set when the ledger entry (ids only) was written outside the database
  ledger_at timestamptz,
  -- counts only (what the preview showed when the member asked)
  preview jsonb,
  CONSTRAINT erasure_requests_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT erasure_requests_approved_ck CHECK (status NOT IN ('approved', 'executing', 'done') OR (grace_until IS NOT NULL AND approved_by IS NOT NULL OR source = 'ledger'))
);
-- one open request per membership (the function serialises, the index is the guarantee)
CREATE UNIQUE INDEX erasure_requests_one_open ON lms.erasure_requests (tenant_id, membership_id)
  WHERE status IN ('pending_approval', 'approved', 'executing');
CREATE INDEX erasure_requests_list_idx ON lms.erasure_requests (tenant_id, requested_at DESC, id);
CREATE INDEX erasure_requests_due_idx ON lms.erasure_requests (status, grace_until) WHERE status = 'approved';
CREATE INDEX erasure_requests_expiry_idx ON lms.erasure_requests (status, expires_at) WHERE status = 'pending_approval';
CREATE INDEX erasure_requests_ledger_idx ON lms.erasure_requests (status, ledger_at) WHERE status = 'done' AND ledger_at IS NULL;

ALTER TABLE lms.erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.erasure_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY erasure_requests_select ON lms.erasure_requests FOR SELECT TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.erasure_requests FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;
GRANT SELECT ON lms.erasure_requests TO lms_app;

-- ---------------------------------------------------------------- the last-admin rule (the same lock the trigger takes)
-- True when the membership is an ACTIVE institution admin and no other active institution admin is left. Takes the tenant's
-- last-admin lock, so a concurrent demotion by an administrator (which takes it in guard_last_admin) is serialised with this check.
CREATE FUNCTION lms.privacy_is_last_admin(p_tenant uuid, p_membership uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lms.last_admin:' || p_tenant::text, 0));
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.id = p_membership AND m.role = 'institution_admin' AND m.status = 'active') THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                      WHERE m.tenant_id = p_tenant AND m.id <> p_membership AND m.role = 'institution_admin' AND m.status = 'active');
END
$$;

-- ---------------------------------------------------------------- what a scrub of the audit trail may remove (the allowlist)
CREATE FUNCTION lms.audit_scrub_metadata(p_meta jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$
  -- The ALLOWLIST of what a scrub may remove:
  --   top level: the address of the actor's client and the addresses of a target (ip, email, toEmail, address, recipient);
  --   inside `before` / `after` (the profile audit rows keep the whole profile row there): phone, designation, register number,
  --   employee id (snake_case from to_jsonb(row), camelCase from application metadata).
  -- Nothing else is ever removed, and nothing is ever changed.
  SELECT coalesce(jsonb_object_agg(k, CASE WHEN k IN ('before', 'after') AND jsonb_typeof(v) = 'object'
                                           THEN v - ARRAY['phone', 'designation', 'register_number', 'employee_id', 'registerNumber', 'employeeId']
                                           ELSE v END), '{}'::jsonb)
    FROM jsonb_each(coalesce(p_meta, '{}'::jsonb)) AS e(k, v)
   WHERE k <> ALL (ARRAY['ip', 'email', 'toEmail', 'address', 'recipient'])
$$;

-- the shape every endpoint returns (internal: no EXECUTE for lms_app)
CREATE FUNCTION lms.privacy_erasure_json(r lms.erasure_requests)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'expiresAt', r.expires_at,
                            'graceUntil', r.grace_until)
$$;
REVOKE ALL ON FUNCTION lms.privacy_erasure_json(lms.erasure_requests) FROM PUBLIC;

-- the member's latest request (or null): one statement
CREATE FUNCTION lms.privacy_erasure_mine(p_tenant uuid, p_user uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('request', (SELECT lms.privacy_erasure_json(r) FROM lms.erasure_requests r
                                          WHERE r.tenant_id = p_tenant AND r.user_id = p_user
                                          ORDER BY r.requested_at DESC, r.id DESC LIMIT 1))
$$;

-- ---------------------------------------------------------------- the preview: COUNTS ONLY
-- "erased" = what the execution removes or anonymises; "kept" = what stays, and why (the words are in the application and in
-- docs/data-retention.md). A count, never a value.
CREATE FUNCTION lms.privacy_erasure_preview(p_tenant uuid, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp SET jit = off
AS $$
DECLARE
  v_mem uuid;
  v_email text;
  v_parts uuid[];
BEGIN
  SELECT m.id INTO v_mem FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active';
  IF v_mem IS NULL THEN RETURN jsonb_build_object('result', 'not_a_member'); END IF;
  SELECT u.email INTO v_email FROM lms.users u WHERE u.id = p_user;
  SELECT coalesce(array_agg(p.id), ARRAY[]::uuid[]) INTO v_parts
    FROM lms.course_participants p WHERE p.tenant_id = p_tenant AND p.membership_id = v_mem;
  RETURN jsonb_build_object(
    'result', 'ok',
    'open', (SELECT lms.privacy_erasure_json(r) FROM lms.erasure_requests r
              WHERE r.tenant_id = p_tenant AND r.membership_id = v_mem AND r.status IN ('pending_approval', 'approved', 'executing')
              ORDER BY r.requested_at DESC LIMIT 1),
    'lastAdmin', (SELECT NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m
                                      WHERE m.tenant_id = p_tenant AND m.id <> v_mem AND m.role = 'institution_admin' AND m.status = 'active')
                         AND EXISTS (SELECT 1 FROM lms.tenant_memberships m
                                      WHERE m.tenant_id = p_tenant AND m.id = v_mem AND m.role = 'institution_admin')),
    'erased', jsonb_build_object(
      'displayName', 1,
      'profileFields', (SELECT count(*) FROM lms.member_profiles mp WHERE mp.tenant_id = p_tenant AND mp.membership_id = v_mem
                          AND (mp.phone IS NOT NULL OR mp.designation IS NOT NULL OR mp.register_number IS NOT NULL OR mp.employee_id IS NOT NULL)),
      'sessions', (SELECT count(*) FROM lms.sessions s WHERE s.tenant_id = p_tenant AND s.user_id = p_user),
      'notifications', (SELECT count(*) FROM lms.notifications n WHERE n.tenant_id = p_tenant AND n.user_id = p_user),
      'notificationPreferences', (SELECT count(*) FROM lms.notification_preferences n WHERE n.tenant_id = p_tenant AND n.user_id = p_user),
      'activityDays', (SELECT count(*) FROM lms.member_activity_days a WHERE a.tenant_id = p_tenant AND a.user_id = p_user),
      'emails', (SELECT count(*) FROM lms.email_outbox o WHERE o.tenant_id = p_tenant AND o.user_id = p_user),
      'importRows', (SELECT count(*) FROM lms.import_rows r WHERE r.tenant_id = p_tenant AND lower(r.email) = lower(v_email)),
      'dataExports', (SELECT count(*) FROM lms.data_exports e WHERE e.tenant_id = p_tenant AND e.user_id = p_user AND e.status <> 'expired'),
      'auditAddresses', (SELECT count(*) FROM lms.audit_log a WHERE a.tenant_id = p_tenant
                           AND (a.actor_user_id = p_user OR a.target_id IN (p_user::text, v_mem::text) OR a.metadata ->> 'userId' = p_user::text
                                OR lower(a.metadata ->> 'email') = lower(v_email))
                           AND a.metadata IS DISTINCT FROM lms.audit_scrub_metadata(a.metadata))),
    'kept', jsonb_build_object(
      'enrolments', coalesce(array_length(v_parts, 1), 0),
      'progressRecords', (SELECT count(*) FROM lms.item_progress ip WHERE ip.tenant_id = p_tenant AND ip.participant_id = ANY (v_parts)),
      'quizAttempts', (SELECT count(*) FROM lms.attempts a WHERE a.tenant_id = p_tenant AND a.participant_id = ANY (v_parts)),
      'submissions', (SELECT count(*) FROM lms.submissions s WHERE s.tenant_id = p_tenant AND s.participant_id = ANY (v_parts)),
      'gradebookSnapshots', (SELECT count(*) FROM lms.gradebook_snapshot_rows r WHERE r.tenant_id = p_tenant AND r.participant_id = ANY (v_parts)),
      'auditEntries', (SELECT count(*) FROM lms.audit_log a WHERE a.tenant_id = p_tenant
                         AND (a.actor_user_id = p_user OR a.target_id IN (p_user::text, v_mem::text)))));
END
$$;

-- ---------------------------------------------------------------- request
CREATE FUNCTION lms.privacy_erasure_request(p_tenant uuid, p_user uuid, p_ip inet, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_mem uuid;
  v_row lms.erasure_requests;
  v_id uuid;
  v_preview jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || p_user::text, 0));
  SELECT m.id INTO v_mem FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status = 'active';
  IF v_mem IS NULL THEN RETURN jsonb_build_object('result', 'not_a_member'); END IF;
  SELECT * INTO v_row FROM lms.erasure_requests r
   WHERE r.tenant_id = p_tenant AND r.membership_id = v_mem AND r.status IN ('pending_approval', 'approved', 'executing');
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'in_progress', 'request', lms.privacy_erasure_json(v_row));
  END IF;
  IF lms.privacy_is_last_admin(p_tenant, v_mem) THEN RETURN jsonb_build_object('result', 'last_admin'); END IF;
  v_preview := lms.privacy_erasure_preview(p_tenant, p_user);
  v_id := lms.uuid_v7();
  INSERT INTO lms.erasure_requests (id, tenant_id, membership_id, user_id, status, requested_at, expires_at, preview)
  VALUES (v_id, p_tenant, v_mem, p_user, 'pending_approval', p_now, p_now + interval '30 days', v_preview);
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_user, 'privacy.erasure_requested', 'erasure_request', v_id::text,
          CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END);
  -- the college's other administrators are told (in the bell and by e-mail); no name, no reason, no count
  PERFORM lms.notify_fanout(coalesce((
    SELECT array_agg(ROW(p_tenant, m.user_id, 'admin', 'erasure_request_received', '{}'::jsonb, '/privacy/erasure',
                         'erasure:' || v_id || ':received', 'erasure_request_received', NULL::timestamptz, true)::lms.notify_item)
      FROM lms.tenant_memberships m
     WHERE m.tenant_id = p_tenant AND m.role = 'institution_admin' AND m.status = 'active' AND m.user_id <> p_user), ARRAY[]::lms.notify_item[]));
  SELECT * INTO v_row FROM lms.erasure_requests r WHERE r.id = v_id;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_erasure_json(v_row));
END
$$;

-- ---------------------------------------------------------------- approve | reject | cancel
-- The caller (the service) checked the permission; this function checks what the database must guarantee:
--   approve / reject: the actor is an ACTIVE institution admin of the college and NOT the person asking (no self-approval);
--   approve: the request is undecided and has not expired, and its member is not the last administrator;
--   cancel: the person asking or an active institution admin, while the request is open and the grace period has not ended.
CREATE FUNCTION lms.privacy_erasure_decide(p_tenant uuid, p_id uuid, p_actor uuid, p_action text, p_now timestamptz, p_ip inet)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.erasure_requests;
  v_admin boolean;
  v_grace timestamptz;
  v_meta jsonb := CASE WHEN p_ip IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ip', host(p_ip)) END;
BEGIN
  IF p_action NOT IN ('approve', 'reject', 'cancel') THEN RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.tenant_id = p_tenant AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  v_admin := EXISTS (SELECT 1 FROM lms.tenant_memberships m
                      WHERE m.tenant_id = p_tenant AND m.user_id = p_actor AND m.role = 'institution_admin' AND m.status = 'active');
  IF p_action = 'cancel' THEN
    IF NOT (p_actor = r.user_id OR v_admin) THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
    IF r.status NOT IN ('pending_approval', 'approved') OR (r.status = 'approved' AND p_now >= r.grace_until) THEN
      RETURN jsonb_build_object('result', 'too_late', 'status', r.status);
    END IF;
    UPDATE lms.erasure_requests SET status = 'cancelled', decided_at = p_now, decided_by = p_actor WHERE id = p_id;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), p_tenant, p_actor, 'privacy.erasure_cancelled', 'erasure_request', p_id::text, v_meta);
    IF p_actor <> r.user_id THEN
      PERFORM lms.notify_fanout(ARRAY[ROW(p_tenant, r.user_id, 'security', 'erasure_request_cancelled', '{}'::jsonb, '/me/data',
                 'erasure:' || p_id || ':cancelled', 'erasure_request_cancelled', NULL::timestamptz, true)::lms.notify_item]);
    END IF;
    SELECT * INTO r FROM lms.erasure_requests e WHERE e.id = p_id;
    RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_erasure_json(r));
  END IF;
  -- approve and reject: administrators only, never one's own request
  IF NOT v_admin THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF p_actor = r.user_id THEN RETURN jsonb_build_object('result', 'self_approval'); END IF;
  IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('result', 'not_pending', 'status', r.status); END IF;
  IF p_now >= r.expires_at THEN RETURN jsonb_build_object('result', 'expired'); END IF;
  IF p_action = 'reject' THEN
    UPDATE lms.erasure_requests SET status = 'rejected', decided_at = p_now, decided_by = p_actor WHERE id = p_id;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), p_tenant, p_actor, 'privacy.erasure_rejected', 'erasure_request', p_id::text, v_meta);
    PERFORM lms.notify_fanout(ARRAY[ROW(p_tenant, r.user_id, 'security', 'erasure_request_rejected', '{}'::jsonb, '/me/data',
               'erasure:' || p_id || ':rejected', 'erasure_request_rejected', NULL::timestamptz, true)::lms.notify_item]);
    SELECT * INTO r FROM lms.erasure_requests e WHERE e.id = p_id;
    RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_erasure_json(r));
  END IF;
  IF lms.privacy_is_last_admin(p_tenant, r.membership_id) THEN RETURN jsonb_build_object('result', 'last_admin'); END IF;
  v_grace := p_now + interval '7 days';
  UPDATE lms.erasure_requests SET status = 'approved', approved_at = p_now, approved_by = p_actor, grace_until = v_grace,
         decided_at = p_now, decided_by = p_actor WHERE id = p_id;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_actor, 'privacy.erasure_approved', 'erasure_request', p_id::text,
          v_meta || jsonb_build_object('graceUntil', v_grace));
  PERFORM lms.notify_fanout(ARRAY[ROW(p_tenant, r.user_id, 'security', 'erasure_request_approved', jsonb_build_object('days', 7), '/me/data',
             'erasure:' || p_id || ':approved', 'erasure_request_approved', NULL::timestamptz, true)::lms.notify_item]);
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.id = p_id;
  RETURN jsonb_build_object('result', 'ok', 'request', lms.privacy_erasure_json(r));
END
$$;

-- ---------------------------------------------------------------- expiry of undecided requests (scheduled)
CREATE FUNCTION lms.privacy_erasure_expire(p_now timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.erasure_requests;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM lms.erasure_requests e
            WHERE e.status = 'pending_approval' AND e.expires_at <= p_now
            ORDER BY e.expires_at, e.id LIMIT least(greatest(p_limit, 1), 500) FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE lms.erasure_requests SET status = 'expired', decided_at = p_now WHERE id = r.id;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), r.tenant_id, NULL, 'privacy.erasure_expired', 'erasure_request', r.id::text, '{}'::jsonb);
    -- the member is told, in the bell AND by e-mail (a security-category notice: it cannot be switched off)
    PERFORM lms.notify_fanout(ARRAY[ROW(r.tenant_id, r.user_id, 'security', 'erasure_request_expired', '{}'::jsonb, '/me/data',
               'erasure:' || r.id || ':expired', 'erasure_request_expired', NULL::timestamptz, true)::lms.notify_item]);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

-- privacy_is_last_admin is internal (the definer functions call it): lms_app gets no EXECUTE on it
REVOKE ALL ON FUNCTION lms.privacy_is_last_admin(uuid, uuid) FROM PUBLIC;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'privacy_erasure_mine(uuid, uuid)',
    'privacy_erasure_preview(uuid, uuid)',
    'privacy_erasure_request(uuid, uuid, inet, timestamptz)',
    'privacy_erasure_decide(uuid, uuid, uuid, text, timestamptz, inet)',
    'privacy_erasure_expire(timestamptz, integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

-- Step 14b-1, part 3b: ERASURE INSIDE A COLLEGE, the execution (migration 0063 has the requests).
--
-- ONE transaction per request does all of this (privacy_erase_core), so a failure anywhere leaves the member exactly as they were:
--   1  the display override (a pseudonym; lms.member_identity shows it everywhere; the search keys follow by trigger)
--   2  the membership becomes 'removed' (the enrolment sync then closes the participations); notify_fanout, email_enqueue_security,
--      email_suppression_clear_tenant and notify_unsubscribe_info all refuse a removed member, so nothing is ever sent to them again
--   3  EVERY session of the member in this college is revoked in the same transaction, and the address / agent of those sessions is wiped
--   4  invite / reset tokens of the membership are deleted; the profile's personal fields (phone, designation, register number,
--      employee id) are nulled; notifications, notification preferences and activity days are deleted
--   5  the member's queued mail is skipped and EVERY outbox row of theirs is blanked (address, parameters); the provider events
--      that belong to those rows lose the address
--   6  the staged rows of imports that carry their address are scrubbed; their data exports are expired (the archives are deleted
--      by the export purge job)
--   7  the audit trail is KEPT; only the keys `ip` / `email` / `toEmail` / `address` / `recipient` of the rows about this member (and the
--      phone, designation, register number and employee id inside the `before` / `after` of their profile rows) are removed, by the one
--      function allowed past the append-only guard (below)
--   8  the suppression rows of their address get the KEYED HASH of it (HMAC-SHA256, computed by the application with a key of its own)
-- KEPT, on purpose: submissions, attempts, grades, progress (the academic record: shown under the pseudonym), the frozen gradebook
-- snapshots (they keep the name and register number they recorded: counsel decides, docs/data-retention.md), the audit entries, backups.
--
-- The audit table's append-only rule is a TRIGGER from this migration on (it was only a missing grant before): UPDATE and DELETE fail
-- for every role, the owner included; the single exception is the scrub described above.

-- ---------------------------------------------------------------- the audit log: append-only, one narrow exception
-- (lms.audit_scrub_metadata, the allowlist of what a scrub may remove, is defined in migration 0063: the preview counts with it)

CREATE FUNCTION lms.audit_log_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  v_setting text := nullif(current_setting('lms.audit_scrub_request', true), '');
  r lms.erasure_requests;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- UPDATE: only inside privacy_scrub_audit, which names an erasure request that is EXECUTING in this very transaction
  IF v_setting IS NULL OR v_setting !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.id = v_setting::uuid AND e.status = 'executing' AND e.tenant_id = OLD.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_log is append-only: no executing erasure request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the row concerns the member of that request (they acted, they are the target, their id is in the metadata, or their address is) ...
  -- (each comparison is NULL when the row lacks that key: `coalesce(..., false)` keeps "unknown" from being read as "yes")
  IF NOT coalesce(OLD.actor_user_id = r.user_id OR OLD.target_id IN (r.user_id::text, r.membership_id::text)
                  OR OLD.metadata ->> 'userId' = r.user_id::text
                  OR lower(OLD.metadata ->> 'email') = lower((SELECT u.email FROM lms.users u WHERE u.id = r.user_id)), false) THEN
    RAISE EXCEPTION 'audit_log is append-only: the row is not about the erased member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- ... and NOTHING changes except that the allowlisted metadata keys are gone
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.metadata IS DISTINCT FROM lms.audit_scrub_metadata(OLD.metadata) THEN
    RAISE EXCEPTION 'audit_log is append-only: a scrub may only remove the allowlisted keys' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.audit_log_guard() FROM PUBLIC;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON lms.audit_log
  FOR EACH ROW EXECUTE FUNCTION lms.audit_log_guard();

-- The ONLY function that sets the scrub setting. It is internal (lms_app has no EXECUTE): the execution and the re-application
-- call it, and it refuses unless the request is executing.
CREATE FUNCTION lms.privacy_scrub_audit(p_request uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.erasure_requests;
  v_email text;
  n integer;
BEGIN
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.id = p_request AND e.status = 'executing';
  IF NOT FOUND THEN RAISE EXCEPTION 'the request is not executing' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT u.email INTO v_email FROM lms.users u WHERE u.id = r.user_id;
  PERFORM set_config('lms.audit_scrub_request', p_request::text, true);
  UPDATE lms.audit_log a SET metadata = lms.audit_scrub_metadata(a.metadata)
   WHERE a.tenant_id = r.tenant_id
     AND (a.actor_user_id = r.user_id OR a.target_id IN (r.user_id::text, r.membership_id::text) OR a.metadata ->> 'userId' = r.user_id::text
          OR lower(a.metadata ->> 'email') = lower(v_email))
     AND a.metadata IS DISTINCT FROM lms.audit_scrub_metadata(a.metadata);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('lms.audit_scrub_request', '', true);
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.privacy_scrub_audit(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------- suppressions: the keyed hash of the address
-- email_hash = HMAC-SHA256(key <email_hash_kid>, lower(address)), computed by the APPLICATION (the key lives in its config, never in the
-- database). While the address still belongs to a live account the plain address stays (the sender compares it); p_drop_plain = true
-- (account-level erasure) replaces it with an unmatchable placeholder, so only the hash remains.
ALTER TABLE lms.email_suppressions ADD COLUMN email_hash bytea CHECK (length(email_hash) = 32);
ALTER TABLE lms.email_suppressions ADD COLUMN email_hash_kid text CHECK (length(email_hash_kid) BETWEEN 1 AND 16);
CREATE INDEX email_suppressions_hash_idx ON lms.email_suppressions (email_hash) WHERE email_hash IS NOT NULL;

CREATE FUNCTION lms.privacy_suppression_seal(p_email text, p_hash bytea, p_kid text, p_drop_plain boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_hash IS NULL OR length(p_hash) <> 32 OR p_kid IS NULL THEN RAISE EXCEPTION 'a keyed hash is required' USING ERRCODE = '22023'; END IF;
  UPDATE lms.email_suppressions s
     SET email_hash = p_hash, email_hash_kid = p_kid,
         email = CASE WHEN p_drop_plain THEN '#' || encode(p_hash, 'hex') ELSE s.email END
   WHERE s.email = lower(p_email);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.privacy_suppression_seal(text, bytea, text, boolean) FROM PUBLIC;

-- ---------------------------------------------------------------- the core (internal)
CREATE FUNCTION lms.privacy_erase_core(p_tenant uuid, p_request uuid, p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.erasure_requests;
  v_pseudo text;
  v_out jsonb := '{}'::jsonb;
  v_outbox uuid[];
  n integer;
BEGIN
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.tenant_id = p_tenant AND e.id = p_request AND e.status = 'executing';
  IF NOT FOUND THEN RAISE EXCEPTION 'the request is not executing' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- 1 the pseudonym (random, not derived from anything about the person)
  v_pseudo := 'Former member ' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  INSERT INTO lms.membership_display_overrides (tenant_id, membership_id, pseudonym)
  VALUES (p_tenant, r.membership_id, v_pseudo) ON CONFLICT (tenant_id, membership_id) DO NOTHING;
  -- 2 the membership is removed (the last-admin trigger exempts the owner: the callers checked the rule under its lock)
  UPDATE lms.tenant_memberships SET status = 'removed', updated_at = now() WHERE tenant_id = p_tenant AND id = r.membership_id;
  -- 3 sessions: all of them, and the address and agent they recorded
  v_out := v_out || jsonb_build_object('sessionsRevoked', lms.auth_revoke_user_sessions(r.user_id, NULL, p_tenant));
  UPDATE lms.sessions SET ip = NULL, user_agent = NULL WHERE tenant_id = p_tenant AND user_id = r.user_id;
  -- 4 tokens, the profile's personal fields, bell, preferences, activity
  DELETE FROM lms.auth_tokens WHERE tenant_id = p_tenant AND membership_id = r.membership_id;
  UPDATE lms.member_profiles SET phone = NULL, designation = NULL, register_number = NULL, employee_id = NULL
   WHERE tenant_id = p_tenant AND membership_id = r.membership_id;
  DELETE FROM lms.notifications WHERE tenant_id = p_tenant AND user_id = r.user_id;
  DELETE FROM lms.notification_preferences WHERE tenant_id = p_tenant AND user_id = r.user_id;
  DELETE FROM lms.member_activity_days WHERE tenant_id = p_tenant AND user_id = r.user_id;
  -- 5 mail: nothing queued is sent, every row of theirs loses the address and the parameters, the provider events lose the address
  SELECT coalesce(array_agg(o.id), ARRAY[]::uuid[]) INTO v_outbox FROM lms.email_outbox o WHERE o.tenant_id = p_tenant AND o.user_id = r.user_id;
  UPDATE lms.email_outbox
     SET status = CASE WHEN status IN ('queued', 'sending') THEN 'skipped' ELSE status END,
         skip_reason = CASE WHEN status IN ('queued', 'sending') THEN 'member_erased' ELSE skip_reason END,
         to_email = 'erased.invalid', params = '{}'::jsonb, last_error = NULL
   WHERE id = ANY (v_outbox);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('emailsBlanked', n);
  UPDATE lms.email_events SET email = NULL WHERE outbox_id = ANY (v_outbox) AND email IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('emailEventsBlanked', n);
  -- 6 staged import rows with the address; archives of their own data
  UPDATE lms.import_rows SET email = NULL, full_name = NULL, register_number = NULL, employee_id = NULL, phone = NULL, raw = '{}'::jsonb
   WHERE tenant_id = p_tenant AND lower(email) = lower(p_email);
  GET DIAGNOSTICS n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('importRowsScrubbed', n);
  UPDATE lms.data_exports
     SET status = CASE WHEN status = 'ready' THEN 'expired' WHEN status IN ('queued', 'building') THEN 'failed' ELSE status END,
         error = CASE WHEN status IN ('queued', 'building') THEN 'member erased' ELSE error END
   WHERE tenant_id = p_tenant AND user_id = r.user_id AND status IN ('ready', 'queued', 'building');
  -- 7 the audit trail: only the allowlisted keys of the rows about the member
  v_out := v_out || jsonb_build_object('auditRowsScrubbed', lms.privacy_scrub_audit(p_request));
  -- 8 suppressions of the address: the keyed hash is recorded (the plain address stays while the account lives)
  v_out := v_out || jsonb_build_object('suppressionsSealed', lms.privacy_suppression_seal(p_email, p_hash, p_kid, false));
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION lms.privacy_erase_core(uuid, uuid, text, bytea, text) FROM PUBLIC;

-- ---------------------------------------------------------------- the worker: what is due, the address, the execution
CREATE FUNCTION lms.privacy_erasure_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (r_tenant uuid, r_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT e.tenant_id, e.id FROM lms.erasure_requests e
   WHERE e.status = 'approved' AND e.grace_until <= p_now
   ORDER BY e.grace_until, e.id LIMIT least(greatest(p_limit, 1), 200)
$$;

-- The address the worker hashes (the keyed hash needs the key, which only the application has). Only for a request that is due.
CREATE FUNCTION lms.privacy_erasure_prepare(p_tenant uuid, p_id uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT coalesce((SELECT jsonb_build_object('result', 'ok', 'email', u.email)
                     FROM lms.erasure_requests e JOIN lms.users u ON u.id = e.user_id
                    WHERE e.tenant_id = p_tenant AND e.id = p_id AND e.status = 'approved' AND e.grace_until <= p_now),
                  jsonb_build_object('result', 'not_due'))
$$;

CREATE FUNCTION lms.privacy_erasure_execute(p_tenant uuid, p_id uuid, p_now timestamptz, p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  r lms.erasure_requests;
  v_mem lms.tenant_memberships;
  v_counts jsonb;
BEGIN
  -- lock order: the request, the membership, the tenant's last-admin lock (cancel locks only the request, an administrator's
  -- suspension or demotion the membership and then the last-admin lock, so there is no cycle)
  SELECT * INTO r FROM lms.erasure_requests e WHERE e.tenant_id = p_tenant AND e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF r.status <> 'approved' THEN RETURN jsonb_build_object('result', 'skip', 'status', r.status); END IF;
  IF p_now < r.grace_until THEN RETURN jsonb_build_object('result', 'not_due'); END IF;
  -- the membership first, then the last-admin lock: the same order as an administrator's demotion (the trigger runs with the row
  -- locked and then takes the lock), so the two can never wait for each other
  SELECT * INTO v_mem FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.id = r.membership_id FOR UPDATE;
  IF lms.privacy_is_last_admin(p_tenant, r.membership_id) THEN
    UPDATE lms.erasure_requests SET status = 'rejected', decided_at = p_now, reason = 'last_admin' WHERE id = p_id;
    INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.erasure_blocked', 'erasure_request', p_id::text, jsonb_build_object('reason', 'last_admin'));
    PERFORM lms.notify_fanout(ARRAY[ROW(p_tenant, r.user_id, 'security', 'erasure_request_rejected', '{}'::jsonb, '/me/data',
               'erasure:' || p_id || ':blocked', 'erasure_request_rejected', NULL::timestamptz, true)::lms.notify_item]);
    RETURN jsonb_build_object('result', 'blocked', 'reason', 'last_admin');
  END IF;
  -- the address the worker hashed must still be the member's (a change in between is retried with a fresh read)
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = r.user_id AND u.email = lower(p_email)) THEN
    RETURN jsonb_build_object('result', 'retry');
  END IF;
  UPDATE lms.erasure_requests SET status = 'executing' WHERE id = p_id;
  v_counts := lms.privacy_erase_core(p_tenant, p_id, p_email, p_hash, p_kid);
  UPDATE lms.erasure_requests SET status = 'done', executed_at = p_now WHERE id = p_id;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.erasure_executed', 'erasure_request', p_id::text, v_counts);
  RETURN jsonb_build_object('result', 'ok', 'membershipId', r.membership_id, 'userId', r.user_id, 'counts', v_counts);
END
$$;

-- ---------------------------------------------------------------- the erasure ledger (ids only, outside the database)
CREATE FUNCTION lms.privacy_erasure_ledger_pending(p_limit integer)
RETURNS TABLE (r_id uuid, r_tenant uuid, r_membership uuid, r_user uuid, r_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT e.id, e.tenant_id, e.membership_id, e.user_id, e.executed_at FROM lms.erasure_requests e
   WHERE e.status = 'done' AND e.ledger_at IS NULL ORDER BY e.executed_at, e.id LIMIT least(greatest(p_limit, 1), 500)
$$;

CREATE FUNCTION lms.privacy_erasure_ledger_done(p_ids uuid[], p_now timestamptz)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH u AS (UPDATE lms.erasure_requests SET ledger_at = p_now WHERE id = ANY (p_ids) AND status = 'done' AND ledger_at IS NULL RETURNING 1)
  SELECT count(*)::integer FROM u
$$;

-- After a RESTORE of an older backup: the person is erased again from the ledger (ids only). The address is read here for the hash.
CREATE FUNCTION lms.privacy_erasure_reapply_prepare(p_tenant uuid, p_membership uuid, p_user uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM lms.membership_display_overrides o WHERE o.tenant_id = p_tenant AND o.membership_id = p_membership)
             THEN jsonb_build_object('result', 'already')
           ELSE coalesce((SELECT jsonb_build_object('result', 'ok', 'email', u.email)
                            FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
                           WHERE m.tenant_id = p_tenant AND m.id = p_membership AND m.user_id = p_user),
                         jsonb_build_object('result', 'nothing_to_do'))
         END
$$;

CREATE FUNCTION lms.privacy_erasure_reapply(p_tenant uuid, p_membership uuid, p_user uuid, p_request uuid, p_at timestamptz, p_now timestamptz,
                                            p_email text, p_hash bytea, p_kid text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_counts jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy.erasure:' || p_user::text, 0));
  IF EXISTS (SELECT 1 FROM lms.membership_display_overrides o WHERE o.tenant_id = p_tenant AND o.membership_id = p_membership) THEN
    RETURN jsonb_build_object('result', 'already');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.id = p_membership AND m.user_id = p_user)
     OR NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_user AND u.email = lower(p_email)) THEN
    RETURN jsonb_build_object('result', 'nothing_to_do');
  END IF;
  -- the request of the restored state (if there is one) becomes done; otherwise the ledger's record is created
  IF EXISTS (SELECT 1 FROM lms.erasure_requests e WHERE e.id = p_request) THEN
    UPDATE lms.erasure_requests SET status = 'executing', grace_until = coalesce(grace_until, p_at), approved_by = coalesce(approved_by, user_id)
     WHERE id = p_request AND tenant_id = p_tenant;
  ELSE
    -- any other open request of that membership (a restored state may hold one) is closed first
    UPDATE lms.erasure_requests SET status = 'cancelled', decided_at = p_now
     WHERE tenant_id = p_tenant AND membership_id = p_membership AND status IN ('pending_approval', 'approved', 'executing');
    INSERT INTO lms.erasure_requests (id, tenant_id, membership_id, user_id, status, source, requested_at, executed_at)
    VALUES (p_request, p_tenant, p_membership, p_user, 'executing', 'ledger', p_at, p_at);
  END IF;
  v_counts := lms.privacy_erase_core(p_tenant, p_request, p_email, p_hash, p_kid);
  UPDATE lms.erasure_requests SET status = 'done', executed_at = coalesce(executed_at, p_at), ledger_at = p_now WHERE id = p_request;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, NULL, 'privacy.erasure_reapplied', 'erasure_request', p_request::text, v_counts);
  RETURN jsonb_build_object('result', 'ok', 'counts', v_counts);
END
$$;

-- Which hash keys are still IN USE (rotation: an old key may be removed from SUPPRESSION_HASH_KEYS only when its id is not listed here)
CREATE FUNCTION lms.privacy_suppression_key_usage()
RETURNS TABLE (r_kid text, r_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT s.email_hash_kid, count(*) FROM lms.email_suppressions s WHERE s.email_hash IS NOT NULL GROUP BY s.email_hash_kid ORDER BY 1
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'privacy_suppression_key_usage()',
    'privacy_erasure_due(timestamptz, integer)',
    'privacy_erasure_prepare(uuid, uuid, timestamptz)',
    'privacy_erasure_execute(uuid, uuid, timestamptz, text, bytea, text)',
    'privacy_erasure_ledger_pending(integer)',
    'privacy_erasure_ledger_done(uuid[], timestamptz)',
    'privacy_erasure_reapply_prepare(uuid, uuid, uuid)',
    'privacy_erasure_reapply(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, bytea, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

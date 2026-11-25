-- 0068: the college-level erasure execution locks the membership FOR NO KEY UPDATE, not FOR UPDATE.
--
-- Why. A sign-in inserts its session row; the foreign key to the membership takes FOR KEY SHARE on the membership row and holds it until the
-- sign-in's transaction ends. FOR UPDATE conflicts with FOR KEY SHARE, so the execution queued behind every sign-in in flight (measured by the
-- held-lock test of this migration: the execution waited for the open sign-in) and, as soon as a sign-in needed anything the execution
-- holds, the two wait for each other. The account-level execution (0067) already uses FOR NO KEY UPDATE for the same reason (CLAUDE.md: a lock
-- on a parent row is FOR NO KEY UPDATE unless the statement deletes the row or changes its key). The college execution only changes
-- `status` and the display override, never the key, so the weaker mode is enough and still serialises with every other FOR (NO KEY) UPDATE:
-- an administrator's demotion / suspension, the sync, the account-level execution.
--
-- Only that one lock mode changes; the body is otherwise the function of 0064. The migration checks that the function kept its
-- SET clauses (search_path), SECURITY DEFINER, volatility, owner and ACL, like 0061 / 0065.

CREATE TEMP TABLE _fn_before ON COMMIT DROP AS
SELECT p.proconfig, p.proacl::text AS acl, p.prosecdef, p.provolatile, p.proowner
  FROM pg_proc p
 WHERE p.oid = 'lms.privacy_erasure_execute(uuid, uuid, timestamptz, text, bytea, text)'::regprocedure;

CREATE OR REPLACE FUNCTION lms.privacy_erasure_execute(p_tenant uuid, p_id uuid, p_now timestamptz, p_email text, p_hash bytea, p_kid text)
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
  -- locked and then takes the lock), so the two can never wait for each other.
  -- NO KEY UPDATE, not UPDATE: a sign-in's session insert holds FOR KEY SHARE on this row until it commits (see the header)
  SELECT * INTO v_mem FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.id = r.membership_id FOR NO KEY UPDATE;
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

DO $$
DECLARE
  b record;
  a record;
BEGIN
  SELECT * INTO b FROM _fn_before;
  SELECT p.proconfig, p.proacl::text AS acl, p.prosecdef, p.provolatile, p.proowner INTO a
    FROM pg_proc p
   WHERE p.oid = 'lms.privacy_erasure_execute(uuid, uuid, timestamptz, text, bytea, text)'::regprocedure;
  IF a.proconfig IS DISTINCT FROM b.proconfig OR a.acl IS DISTINCT FROM b.acl OR a.prosecdef IS DISTINCT FROM b.prosecdef
     OR a.provolatile IS DISTINCT FROM b.provolatile OR a.proowner IS DISTINCT FROM b.proowner THEN
    RAISE EXCEPTION '0068: privacy_erasure_execute lost a setting (proconfig, ACL, SECURITY DEFINER, volatility or owner)';
  END IF;
END
$$;

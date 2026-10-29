-- Audit log screens show WHO did something (display name and email), not only the actor id.
--
-- Tenant log (lms.audit_log): joined to lms.users in the same query by the application role; row-level
-- security on users decides what is visible (current members and the signed-in user), so a removed
-- member shows up as "Unknown user". No schema change needed.
--
-- Platform log: lms_app has no table access, so the SECURITY DEFINER read function gets a v2 that also
-- returns the actor name and email. Expand -> migrate -> contract: platform_list_audit (v1) stays for
-- now and is dropped in a LATER migration once nothing calls it any more.
CREATE FUNCTION lms.platform_list_audit_v2(
  p_actor uuid, p_action text, p_from timestamptz, p_to timestamptz,
  p_after_at timestamptz, p_after_id uuid, p_limit integer
)
RETURNS TABLE (
  r_id uuid, r_actor_user_id uuid, r_action text, r_target_type text, r_target_id text,
  r_metadata jsonb, r_created_at timestamptz, r_cursor_at text,
  r_actor_name text, r_actor_email text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.actor_user_id, a.action, a.target_type, a.target_id, a.metadata, a.created_at,
           to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           x.display_name::text, x.email::text
      FROM lms.platform_audit_log a
      LEFT JOIN lms.users x ON x.id = a.actor_user_id
     WHERE (p_action IS NULL OR a.action = p_action)
       AND (p_from IS NULL OR a.created_at >= p_from)
       AND (p_to IS NULL OR a.created_at < p_to)
       AND (p_after_at IS NULL OR (a.created_at, a.id) < (p_after_at, p_after_id))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 1001);
END
$$;

REVOKE ALL ON FUNCTION lms.platform_list_audit_v2(uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_list_audit_v2(uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer) TO lms_app;

-- Step 10c: the file calls of a learner answer like every offering route: a member who takes no part in the offering gets
-- the gate's verdict ('no_offering' -> 404 offering_not_found), a participant who is not a learner gets 'forbidden' (403),
-- and only a real learner hears "no such file". (assignment_file_access used to answer 'not_found' to everybody.)
-- assignment_upload_check is the same gate for confirming a draft upload.

CREATE OR REPLACE FUNCTION lms.assignment_file_access(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid)
RETURNS TABLE (result text, storage_key text, original_name text, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
  a lms.assignments;
  ok boolean;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN
    RETURN QUERY SELECT g.verdict::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF g.kind <> 'assignment' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO a FROM lms.assignments WHERE tenant_id = p_tenant AND item_id = p_item;
  ok := EXISTS (SELECT 1 FROM lms.assignment_attachments x
                 WHERE x.tenant_id = p_tenant AND x.assignment_item_id = p_item AND x.file_id = p_file)
     OR EXISTS (SELECT 1 FROM lms.submission_files sf
                  JOIN lms.submissions s ON s.tenant_id = sf.tenant_id AND s.id = sf.submission_id
                 WHERE sf.tenant_id = p_tenant AND sf.file_id = p_file AND s.assignment_item_id = p_item
                   AND s.participant_id = g.participant_id)
     OR EXISTS (SELECT 1 FROM lms.assignment_uploads u
                 WHERE u.tenant_id = p_tenant AND u.file_id = p_file AND u.assignment_item_id = p_item
                   AND u.participant_id = g.participant_id)
     OR EXISTS (SELECT 1 FROM lms.assignment_feedback_files ff
                  JOIN lms.assignment_grades gr ON gr.tenant_id = ff.tenant_id
                   AND gr.assignment_item_id = ff.assignment_item_id AND gr.participant_id = ff.participant_id
                 WHERE ff.tenant_id = p_tenant AND ff.file_id = p_file AND ff.assignment_item_id = p_item
                   AND ff.participant_id = g.participant_id
                   AND (gr.released_at IS NOT NULL OR a.release_mode = 'immediate'));
  IF NOT ok THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, f.storage_key, f.original_name, f.content_type
                 FROM lms.files f WHERE f.tenant_id = p_tenant AND f.id = p_file AND f.status = 'ready';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
  END IF;
END
$$;

CREATE FUNCTION lms.assignment_upload_check(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_file uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  g record;
BEGIN
  SELECT * INTO g FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF g.verdict <> 'ok' THEN RETURN g.verdict::text; END IF;
  IF g.kind <> 'assignment' THEN RETURN 'not_found'; END IF;
  IF EXISTS (SELECT 1 FROM lms.assignment_uploads u
              WHERE u.tenant_id = p_tenant AND u.file_id = p_file AND u.assignment_item_id = p_item
                AND u.participant_id = g.participant_id) THEN
    RETURN 'ok';
  END IF;
  RETURN 'not_found';
END
$$;
REVOKE ALL ON FUNCTION lms.assignment_upload_check(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_upload_check(uuid, uuid, uuid, uuid, uuid) TO lms_app;

-- Step 11: the gradebook workflow and endpoints' database functions.
--
-- Staff calls are SECURITY INVOKER functions (row-level security limits them to the caller's college) that the application
-- calls in the SAME statement as the offering access check (`WITH acc AS (...) SELECT lms.fn(...) FROM acc WHERE allowed`):
-- one statement per request, the access decision and the work in one snapshot. The learner call is a SECURITY DEFINER
-- function on an autocommit connection (2 round trips with the session lookup), like the learner calls of steps 9 and 10.
-- Results are jsonb with a `result` code; the service maps the code to an HTTP error. Nothing is raised for an expected
-- failure, so a refused action that must still be recorded (a blocked self-approval) can write its audit row.

CREATE FUNCTION lms.gb_audit(p_tenant uuid, p_user uuid, p_action text, p_target uuid, p_meta jsonb)
RETURNS void
LANGUAGE sql SET search_path = lms, pg_temp
AS $$
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (lms.uuid_v7(), p_tenant, p_user, p_action, 'gradebook', p_target::text, p_meta)
$$;

CREATE FUNCTION lms.gb_self_approval(p_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce((SELECT (s.value ->> 'allowSelfApproval') = 'true' FROM lms.tenant_settings s
                    WHERE s.tenant_id = p_tenant AND s.key = 'gradebook'), false)
$$;

-- the structure of a gradebook as JSON (the same shape is frozen into a snapshot)
CREATE FUNCTION lms.gradebook_config_json(p_tenant uuid, p_gb uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object(
    'weighted', g.weighted, 'outOf', g.out_of, 'roundMode', g.round_mode, 'roundDecimals', g.round_decimals,
    'scale', (SELECT jsonb_build_object('id', s.id, 'name', s.name,
                'bands', (SELECT coalesce(jsonb_agg(jsonb_build_object('minPercent', b.min_percent, 'label', b.label,
                                 'gradePoints', b.grade_points, 'isPass', b.is_pass) ORDER BY b.min_percent DESC), '[]'::jsonb)
                            FROM lms.grade_scale_bands b WHERE b.tenant_id = s.tenant_id AND b.scale_id = s.id))
                FROM lms.grade_scales s WHERE s.tenant_id = g.tenant_id AND s.id = g.scale_id),
    'categories', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'weight', c.weight,
                          'dropLowest', c.drop_lowest, 'missingPolicy', c.missing_policy) ORDER BY c.position, c.id), '[]'::jsonb)
                     FROM lms.gradebook_categories c WHERE c.tenant_id = g.tenant_id AND c.gradebook_id = g.id),
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'categoryId', i.category_id, 'source', i.source,
                      'contentItemId', i.content_item_id, 'title', coalesce(i.title, ci.title), 'points', i.points,
                      'extraCredit', i.extra_credit, 'dueAt', i.due_at, 'released', i.released,
                      'assistantsMayEnter', i.assistants_may_enter) ORDER BY i.position, i.id), '[]'::jsonb)
                FROM lms.gradebook_items i
                LEFT JOIN lms.content_items ci ON ci.tenant_id = i.tenant_id AND ci.id = i.content_item_id
               WHERE i.tenant_id = g.tenant_id AND i.gradebook_id = g.id AND i.archived_at IS NULL
                 AND (i.source = 'manual' OR ci.deleted_at IS NULL)))
    FROM lms.gradebooks g WHERE g.tenant_id = p_tenant AND g.id = p_gb
$$;

-- What the screens need besides the structure: the status, the recent events, the items not yet in the gradebook.
CREATE FUNCTION lms.gradebook_config(p_tenant uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT lms.gradebook_config_json(p_tenant, g.id)
         || jsonb_build_object(
           'id', g.id, 'offeringId', g.offering_id, 'status', g.status, 'versionNo', g.version_no,
           'exportLayout', g.export_layout, 'submittedAt', g.submitted_at, 'reviewComment', g.review_comment,
           'submittedBy', (SELECT u.display_name FROM lms.users u WHERE u.id = g.submitted_by),
           'selfApprovalAllowed', lms.gb_self_approval(g.tenant_id),
           'lockedVersions', (SELECT coalesce(jsonb_agg(jsonb_build_object('versionNo', v.version_no, 'lockedAt', v.locked_at,
                                      'learnerCount', v.learner_count, 'excluded', v.excluded, 'selfApproved', v.self_approved,
                                      'approvedBy', (SELECT u.display_name FROM lms.users u WHERE u.id = v.approved_by))
                                      ORDER BY v.version_no DESC), '[]'::jsonb)
                                FROM lms.gradebook_versions v WHERE v.tenant_id = g.tenant_id AND v.gradebook_id = g.id),
           'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'at', e.created_at,
                               'by', (SELECT u.display_name FROM lms.users u WHERE u.id = e.actor_user_id),
                               'comment', e.comment, 'versionNo', e.version_no, 'selfApproved', e.self_approved)
                               ORDER BY e.created_at DESC, e.id DESC), '[]'::jsonb)
                        FROM (SELECT * FROM lms.gradebook_events e0 WHERE e0.tenant_id = g.tenant_id AND e0.gradebook_id = g.id
                               ORDER BY e0.created_at DESC, e0.id DESC LIMIT 20) e),
           'candidates', (SELECT coalesce(jsonb_agg(jsonb_build_object('contentItemId', ci.id, 'title', ci.title, 'kind', ci.kind,
                               'defaultPoints', CASE ci.kind
                                  WHEN 'assignment' THEN (SELECT a.max_points FROM lms.assignments a WHERE a.tenant_id = ci.tenant_id AND a.item_id = ci.id)
                                  ELSE coalesce((SELECT sum(sl.points * sl.count) FROM lms.assessment_slots sl
                                                  WHERE sl.tenant_id = ci.tenant_id AND sl.assessment_item_id = ci.id), 100) END)
                               ORDER BY ci.title, ci.id), '[]'::jsonb)
                            FROM lms.content_items ci
                           WHERE ci.tenant_id = g.tenant_id AND ci.offering_id = g.offering_id
                             AND ci.kind IN ('assessment', 'assignment') AND ci.deleted_at IS NULL
                             AND NOT EXISTS (SELECT 1 FROM lms.gradebook_items i
                                              WHERE i.tenant_id = g.tenant_id AND i.gradebook_id = g.id
                                                AND i.content_item_id = ci.id AND i.archived_at IS NULL)),
           'markCounts', (SELECT coalesce(jsonb_object_agg(x.item_id, x.n), '{}'::jsonb)
                            FROM (SELECT m.item_id, count(*) AS n FROM lms.manual_marks m
                                   WHERE m.tenant_id = g.tenant_id AND m.item_id IN (
                                     SELECT i.id FROM lms.gradebook_items i WHERE i.tenant_id = g.tenant_id AND i.gradebook_id = g.id)
                                   GROUP BY m.item_id) x))
    FROM lms.gradebooks g WHERE g.tenant_id = p_tenant AND g.offering_id = p_offering
$$;

-- ------------------------------------------------------------------ settings, categories, items (editable states only)
CREATE FUNCTION lms.gradebook_settings_update(p_tenant uuid, p_user uuid, p_offering uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  before jsonb;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  IF p_patch ? 'scaleId' AND p_patch ->> 'scaleId' IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM lms.grade_scales s WHERE s.tenant_id = p_tenant AND s.id = (p_patch ->> 'scaleId')::uuid
          AND s.archived_at IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid', 'details',
      jsonb_build_array(jsonb_build_object('path', 'scaleId', 'message', 'this grade scale does not exist')));
  END IF;
  before := lms.gradebook_config_json(p_tenant, g.id) - 'categories' - 'items';
  UPDATE lms.gradebooks SET
    weighted = coalesce((p_patch ->> 'weighted')::boolean, weighted),
    out_of = coalesce((p_patch ->> 'outOf')::numeric, out_of),
    round_mode = coalesce(p_patch ->> 'roundMode', round_mode),
    round_decimals = coalesce((p_patch ->> 'roundDecimals')::smallint, round_decimals),
    scale_id = CASE WHEN p_patch ? 'scaleId' THEN (p_patch ->> 'scaleId')::uuid ELSE scale_id END,
    export_layout = CASE WHEN p_patch ? 'exportLayout' THEN nullif(p_patch -> 'exportLayout', 'null'::jsonb) ELSE export_layout END,
    updated_at = now()
   WHERE id = g.id;
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.settings_updated', g.id, jsonb_build_object(
    'offeringId', p_offering, 'before', before, 'after', lms.gradebook_config_json(p_tenant, g.id) - 'categories' - 'items'));
  RETURN jsonb_build_object('result', 'ok', 'config', lms.gradebook_config(p_tenant, p_offering));
END
$$;

-- p_cats: [{id?, name, weight, dropLowest, missingPolicy}] in display order. A category that is left out is deleted when no
-- item (not even an archived one) was ever put in it.
CREATE FUNCTION lms.gradebook_categories_save(p_tenant uuid, p_user uuid, p_offering uuid, p_cats jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  e jsonb;
  ord integer := 0;
  cid uuid;
  busy text;
  before jsonb;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  IF jsonb_array_length(p_cats) = 0 THEN
    RETURN jsonb_build_object('result', 'invalid', 'details',
      jsonb_build_array(jsonb_build_object('path', 'categories', 'message', 'a gradebook needs at least one category')));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cats) x WHERE x ->> 'id' IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM lms.gradebook_categories c WHERE c.tenant_id = p_tenant
                                AND c.gradebook_id = g.id AND c.id = (x ->> 'id')::uuid)) THEN
    RETURN jsonb_build_object('result', 'invalid', 'details',
      jsonb_build_array(jsonb_build_object('path', 'categories', 'message', 'a category does not belong to this gradebook')));
  END IF;
  before := lms.gradebook_config_json(p_tenant, g.id) -> 'categories';
  -- left out: delete when empty
  SELECT c.name INTO busy FROM lms.gradebook_categories c
   WHERE c.tenant_id = p_tenant AND c.gradebook_id = g.id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_cats) x WHERE (x ->> 'id') = c.id::text)
     AND EXISTS (SELECT 1 FROM lms.gradebook_items i WHERE i.tenant_id = p_tenant AND i.category_id = c.id)
   LIMIT 1;
  IF busy IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'category_in_use', 'name', busy);
  END IF;
  DELETE FROM lms.gradebook_categories c
   WHERE c.tenant_id = p_tenant AND c.gradebook_id = g.id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_cats) x WHERE (x ->> 'id') = c.id::text);
  -- park the names of the categories that stay, so two categories can swap names in one save
  UPDATE lms.gradebook_categories c SET name = '~' || c.id::text
   WHERE c.tenant_id = p_tenant AND c.gradebook_id = g.id;
  FOR e IN SELECT x FROM jsonb_array_elements(p_cats) x LOOP
    ord := ord + 1;
    IF e ->> 'id' IS NOT NULL THEN
      UPDATE lms.gradebook_categories SET name = btrim(e ->> 'name'), weight = (e ->> 'weight')::numeric,
             drop_lowest = (e ->> 'dropLowest')::smallint, missing_policy = e ->> 'missingPolicy', position = ord
       WHERE tenant_id = p_tenant AND id = (e ->> 'id')::uuid;
    ELSE
      cid := lms.uuid_v7();
      INSERT INTO lms.gradebook_categories (id, tenant_id, gradebook_id, name, weight, drop_lowest, missing_policy, position)
      VALUES (cid, p_tenant, g.id, btrim(e ->> 'name'), (e ->> 'weight')::numeric, (e ->> 'dropLowest')::smallint,
              e ->> 'missingPolicy', ord);
    END IF;
  END LOOP;
  UPDATE lms.gradebooks SET updated_at = now() WHERE id = g.id;
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.categories_saved', g.id, jsonb_build_object(
    'offeringId', p_offering, 'before', before, 'after', lms.gradebook_config_json(p_tenant, g.id) -> 'categories'));
  RETURN jsonb_build_object('result', 'ok', 'config', lms.gradebook_config(p_tenant, p_offering));
END
$$;

-- p_items: [{id?, source, contentItemId?, title?, categoryId, points, extraCredit, dueAt?, released?, assistantsMayEnter?}]
-- in display order. An item that is left out is ARCHIVED (marks, overrides and snapshots keep pointing at it).
CREATE FUNCTION lms.gradebook_items_save(p_tenant uuid, p_user uuid, p_offering uuid, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  e jsonb;
  ord integer := 0;
  before jsonb;
  cur lms.gradebook_items;
  ci record;
  problems jsonb := '[]'::jsonb;
  i integer := -1;
  kept uuid[] := ARRAY[]::uuid[];
  nid uuid;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  before := lms.gradebook_config_json(p_tenant, g.id) -> 'items';
  FOR e IN SELECT x FROM jsonb_array_elements(p_items) x LOOP
    i := i + 1;
    ord := ord + 1;
    IF NOT EXISTS (SELECT 1 FROM lms.gradebook_categories c WHERE c.tenant_id = p_tenant AND c.gradebook_id = g.id
                    AND c.id = (e ->> 'categoryId')::uuid) THEN
      problems := problems || jsonb_build_object('path', format('items[%s].categoryId', i), 'message', 'unknown category');
      CONTINUE;
    END IF;
    IF e ->> 'id' IS NOT NULL THEN
      SELECT * INTO cur FROM lms.gradebook_items WHERE tenant_id = p_tenant AND gradebook_id = g.id AND id = (e ->> 'id')::uuid;
      IF NOT FOUND THEN
        problems := problems || jsonb_build_object('path', format('items[%s].id', i), 'message', 'unknown item');
        CONTINUE;
      END IF;
      kept := kept || cur.id;
      IF cur.source = 'manual' THEN
        UPDATE lms.gradebook_items SET category_id = (e ->> 'categoryId')::uuid, title = btrim(e ->> 'title'),
               points = (e ->> 'points')::numeric, extra_credit = coalesce((e ->> 'extraCredit')::boolean, false),
               position = ord, due_at = (e ->> 'dueAt')::timestamptz, released = coalesce((e ->> 'released')::boolean, false),
               assistants_may_enter = coalesce((e ->> 'assistantsMayEnter')::boolean, false), archived_at = NULL
         WHERE tenant_id = p_tenant AND id = cur.id;
      ELSE
        UPDATE lms.gradebook_items SET category_id = (e ->> 'categoryId')::uuid, points = (e ->> 'points')::numeric,
               extra_credit = coalesce((e ->> 'extraCredit')::boolean, false), position = ord, archived_at = NULL
         WHERE tenant_id = p_tenant AND id = cur.id;
      END IF;
    ELSIF e ->> 'source' = 'manual' THEN
      nid := lms.uuid_v7();
      kept := kept || nid;
      INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, title, points, extra_credit,
                                       position, due_at, released, assistants_may_enter)
      VALUES (nid, p_tenant, g.id, (e ->> 'categoryId')::uuid, 'manual', btrim(e ->> 'title'),
              (e ->> 'points')::numeric, coalesce((e ->> 'extraCredit')::boolean, false), ord,
              (e ->> 'dueAt')::timestamptz, coalesce((e ->> 'released')::boolean, false),
              coalesce((e ->> 'assistantsMayEnter')::boolean, false));
    ELSE
      SELECT c.id, c.kind INTO ci FROM lms.content_items c
       WHERE c.tenant_id = p_tenant AND c.offering_id = p_offering AND c.id = (e ->> 'contentItemId')::uuid
         AND c.kind = (e ->> 'source') AND c.deleted_at IS NULL;
      IF NOT FOUND THEN
        problems := problems || jsonb_build_object('path', format('items[%s].contentItemId', i),
                                                   'message', 'this item is not an assessment or assignment of the offering');
        CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM lms.gradebook_items x WHERE x.tenant_id = p_tenant AND x.gradebook_id = g.id
                  AND x.content_item_id = ci.id AND x.archived_at IS NULL) THEN
        problems := problems || jsonb_build_object('path', format('items[%s].contentItemId', i), 'message', 'already in the gradebook');
        CONTINUE;
      END IF;
      -- an archived item of the same content item comes back (its marks and history stay attached)
      UPDATE lms.gradebook_items SET archived_at = NULL, category_id = (e ->> 'categoryId')::uuid,
             points = (e ->> 'points')::numeric, extra_credit = coalesce((e ->> 'extraCredit')::boolean, false), position = ord
       WHERE tenant_id = p_tenant AND gradebook_id = g.id AND content_item_id = ci.id
       RETURNING id INTO nid;
      IF NOT FOUND THEN
        nid := lms.uuid_v7();
        INSERT INTO lms.gradebook_items (id, tenant_id, gradebook_id, category_id, source, content_item_id, points,
                                         extra_credit, position)
        VALUES (nid, p_tenant, g.id, (e ->> 'categoryId')::uuid, ci.kind, ci.id, (e ->> 'points')::numeric,
                coalesce((e ->> 'extraCredit')::boolean, false), ord);
      END IF;
      kept := kept || nid;
    END IF;
  END LOOP;
  IF jsonb_array_length(problems) > 0 THEN
    -- nothing of this call is kept
    RAISE EXCEPTION 'gradebook_items_invalid' USING ERRCODE = 'P0001', DETAIL = problems::text;
  END IF;
  UPDATE lms.gradebook_items i2 SET archived_at = now()
   WHERE i2.tenant_id = p_tenant AND i2.gradebook_id = g.id AND i2.archived_at IS NULL AND i2.id <> ALL (kept);
  UPDATE lms.gradebooks SET updated_at = now() WHERE id = g.id;
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.items_saved', g.id, jsonb_build_object(
    'offeringId', p_offering, 'before', before, 'after', lms.gradebook_config_json(p_tenant, g.id) -> 'items'));
  RETURN jsonb_build_object('result', 'ok', 'config', lms.gradebook_config(p_tenant, p_offering));
END
$$;

-- ------------------------------------------------------------------ the grid, the explanation
CREATE FUNCTION lms.gradebook_grid(p_tenant uuid, p_offering uuid, p_section uuid, p_after_sk text, p_after_id uuid,
                                   p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  ids uuid[];
  more boolean;
  total integer := NULL;
  rows_json jsonb;
  last_key text;
BEGIN
  SELECT array_agg(q.id ORDER BY q.rn) FILTER (WHERE q.rn <= p_limit), coalesce(max(q.rn), 0) > p_limit
    INTO ids, more
    FROM (SELECT p.id, row_number() OVER (ORDER BY coalesce(mp.register_number, '~') COLLATE "C", p.id) AS rn
            FROM lms.course_participants p
            JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
            LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
           WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner' AND p.status = 'active'
             AND (p_section IS NULL OR mp.section_id = p_section)
             AND (p_after_sk IS NULL
                  OR (coalesce(mp.register_number, '~') COLLATE "C", p.id) > (p_after_sk COLLATE "C", p_after_id))
           ORDER BY coalesce(mp.register_number, '~') COLLATE "C", p.id
           LIMIT p_limit + 1) q;
  -- NULL would mean "every learner" to the calculation: an empty page is an empty array
  ids := coalesce(ids, ARRAY[]::uuid[]);
  IF p_after_sk IS NULL THEN
    SELECT count(*)::integer INTO total
      FROM lms.course_participants p
      LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = p.membership_id
     WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner' AND p.status = 'active'
       AND (p_section IS NULL OR mp.section_id = p_section);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'participantId', r.participant_id, 'name', u.display_name, 'email', u.email,
           'registerNumber', mp.register_number, 'section', sec.code,
           'cells', r.cells, 'cats', r.cats, 'finalMarks', r.final_marks, 'finalPercent', r.final_percent,
           'grade', r.grade, 'isPass', r.is_pass, 'overridden', r.overridden)
           ORDER BY coalesce(mp.register_number, '~') COLLATE "C", r.participant_id), '[]'::jsonb),
         (array_agg(coalesce(mp.register_number, '~') || '|' || r.participant_id::text
                    ORDER BY coalesce(mp.register_number, '~') COLLATE "C" DESC, r.participant_id DESC))[1]
    INTO rows_json, last_key
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', ids, false) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.users u ON u.id = tm.user_id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id;
  RETURN jsonb_build_object('rows', rows_json, 'next', CASE WHEN more THEN last_key END, 'total', total);
END
$$;

CREATE FUNCTION lms.gradebook_explain(p_tenant uuid, p_offering uuid, p_participant uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object(
           'participantId', r.participant_id, 'name', u.display_name, 'email', u.email,
           'registerNumber', mp.register_number, 'section', sec.code,
           'explanation', r.explanation, 'cells', r.cells,
           'overrides', (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', o.item_id, 'points', o.points, 'reason', o.reason,
                                   'setAt', o.set_at, 'setBy', (SELECT us.display_name FROM lms.users us WHERE us.id = o.set_by))
                                   ORDER BY o.set_at), '[]'::jsonb)
                           FROM lms.grade_overrides o JOIN lms.gradebooks g ON g.tenant_id = o.tenant_id AND g.id = o.gradebook_id
                          WHERE o.tenant_id = p_tenant AND g.offering_id = p_offering AND o.participant_id = r.participant_id
                            AND o.revoked_at IS NULL))
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', ARRAY[p_participant], true) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.users u ON u.id = tm.user_id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id
$$;

-- ------------------------------------------------------------------ manual marks
-- p_cells: [{itemId, participantId, points|null, expected?}]. A cell with `expected` is applied only if the stored value is
-- still that value (otherwise it is reported as a conflict with the current value). `points` null clears the cell.
-- p_all_items: false for an assistant (only items that allow assistants). Returns the recomputed rows of the learners touched.
CREATE FUNCTION lms.gradebook_marks_save(p_tenant uuid, p_user uuid, p_offering uuid, p_all_items boolean, p_source text,
                                         p_cells jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  r jsonb;
  touched uuid[];
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  WITH c AS (
    SELECT DISTINCT ON ((e ->> 'itemId'), (e ->> 'participantId'))
           (e ->> 'itemId')::uuid AS item_id, (e ->> 'participantId')::uuid AS pid,
           nullif(e ->> 'points', '')::numeric AS pts,
           (e ? 'expected') AS has_exp, nullif(e ->> 'expected', '')::numeric AS expd
      FROM jsonb_array_elements(p_cells) WITH ORDINALITY t(e, ord)
     ORDER BY (e ->> 'itemId'), (e ->> 'participantId'), ord DESC),
  v AS (
    SELECT c.*, i.points AS max_pts, i.id IS NOT NULL AS item_ok,
           (p_all_items OR i.assistants_may_enter) AS allowed,
           p.id IS NOT NULL AS part_ok, cur.points AS cur_pts
      FROM c
      LEFT JOIN lms.gradebook_items i ON i.tenant_id = p_tenant AND i.gradebook_id = g.id AND i.id = c.item_id
                                     AND i.source = 'manual' AND i.archived_at IS NULL
      LEFT JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.id = c.pid
                                         AND p.participation = 'learner' AND p.status = 'active'
      LEFT JOIN lms.manual_marks cur ON cur.tenant_id = p_tenant AND cur.item_id = c.item_id AND cur.participant_id = c.pid),
  cls AS (
    SELECT v.*, CASE
        WHEN NOT v.item_ok THEN 'bad_item'
        WHEN NOT v.allowed THEN 'forbidden'
        WHEN NOT v.part_ok THEN 'bad_participant'
        WHEN v.pts IS NOT NULL AND (v.pts < 0 OR v.pts > v.max_pts OR scale(v.pts) > 2) THEN 'bad_value'
        WHEN v.has_exp AND v.expd IS DISTINCT FROM v.cur_pts THEN 'conflict'
        WHEN v.pts IS NOT DISTINCT FROM v.cur_pts THEN 'same'
        ELSE 'apply' END AS kind
      FROM v),
  go AS (SELECT NOT EXISTS (SELECT 1 FROM cls WHERE kind = 'forbidden') AS ok),
  up AS (
    INSERT INTO lms.manual_marks AS m (tenant_id, item_id, participant_id, points, rev, entered_by)
    SELECT p_tenant, cls.item_id, cls.pid, cls.pts, 1, p_user FROM cls, go WHERE go.ok AND cls.kind = 'apply' AND cls.pts IS NOT NULL
    ON CONFLICT (tenant_id, item_id, participant_id) DO UPDATE
      SET points = EXCLUDED.points, rev = m.rev + 1, entered_by = EXCLUDED.entered_by, entered_at = now()
    RETURNING 1),
  del AS (
    DELETE FROM lms.manual_marks m USING cls, go
     WHERE go.ok AND cls.kind = 'apply' AND cls.pts IS NULL
       AND m.tenant_id = p_tenant AND m.item_id = cls.item_id AND m.participant_id = cls.pid
    RETURNING 1),
  hist AS (
    INSERT INTO lms.manual_mark_history (id, tenant_id, item_id, participant_id, before_points, after_points, source, changed_by)
    SELECT lms.uuid_v7(), p_tenant, cls.item_id, cls.pid, cls.cur_pts, cls.pts, p_source, p_user
      FROM cls, go WHERE go.ok AND cls.kind = 'apply'
    RETURNING 1)
  SELECT jsonb_build_object(
           'forbidden', NOT (SELECT ok FROM go),
           'saved', (SELECT count(*) FROM cls, go WHERE go.ok AND cls.kind = 'apply'),
           'unchanged', (SELECT count(*) FROM cls WHERE kind = 'same'),
           'conflicts', (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item_id, 'participantId', pid, 'current', cur_pts)), '[]'::jsonb)
                           FROM (SELECT * FROM cls WHERE kind = 'conflict' LIMIT 200) x),
           'invalid', (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item_id, 'participantId', pid, 'reason', kind)), '[]'::jsonb)
                         FROM (SELECT * FROM cls WHERE kind IN ('bad_item', 'bad_participant', 'bad_value') LIMIT 200) x),
           'touched', (SELECT coalesce(array_agg(DISTINCT pid), ARRAY[]::uuid[]) FROM cls, go WHERE go.ok AND cls.kind = 'apply'),
           -- force the data-modifying CTEs to run
           'writes', (SELECT count(*) FROM up) + (SELECT count(*) FROM del) + (SELECT count(*) FROM hist))
    INTO r;
  IF (r ->> 'forbidden')::boolean THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO touched FROM jsonb_array_elements_text(r -> 'touched') x;
  IF (r ->> 'saved')::integer > 0 THEN
    PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.marks_saved', g.id, jsonb_build_object(
      'offeringId', p_offering, 'source', p_source, 'cells', (r ->> 'saved')::integer,
      'learners', coalesce(array_length(touched, 1), 0)));
  END IF;
  RETURN (r - 'touched' - 'writes') || jsonb_build_object('result', 'ok', 'rows',
    (SELECT coalesce(jsonb_object_agg(c.participant_id, jsonb_build_object('cells', c.cells, 'cats', c.cats,
              'finalMarks', c.final_marks, 'finalPercent', c.final_percent, 'grade', c.grade, 'isPass', c.is_pass,
              'overridden', c.overridden)), '{}'::jsonb)
       FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', touched, false) c));
END
$$;

-- ------------------------------------------------------------------ CSV import of marks
-- Stage: p_cells [{row, cell, register, column, raw}] (the service parsed the file; a column is matched to a manual item
-- by its title, case-insensitively). One set-based validation; nothing is written to the marks.
CREATE FUNCTION lms.gradebook_import_stage(p_tenant uuid, p_user uuid, p_offering uuid, p_all_items boolean, p_rows integer,
                                           p_cells jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  imp uuid := lms.uuid_v7();
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  INSERT INTO lms.mark_imports (id, tenant_id, gradebook_id, row_count, created_by) VALUES (imp, p_tenant, g.id, p_rows, p_user);
  INSERT INTO lms.mark_import_cells (tenant_id, import_id, row_no, cell_no, register_number, column_name, raw)
  SELECT p_tenant, imp, (e ->> 'row')::integer, (e ->> 'cell')::smallint, e ->> 'register', e ->> 'column', e ->> 'raw'
    FROM jsonb_array_elements(p_cells) e;
  UPDATE lms.mark_import_cells c SET item_id = x.item_id, participant_id = x.pid, points = x.pts, error = x.err
    FROM (SELECT c2.row_no, c2.cell_no, pp.pid, i.id AS item_id,
                 CASE WHEN c2.raw ~ '^[0-9]{1,6}([.][0-9]{1,2})?$' THEN c2.raw::numeric END AS pts,
                 CASE
                   WHEN i.id IS NULL THEN 'unknown column'
                   WHEN NOT (p_all_items OR i.assistants_may_enter) THEN 'you may not enter marks in this column'
                   WHEN pp.pid IS NULL THEN 'no learner of this class has this register number'
                   WHEN c2.raw !~ '^[0-9]{1,6}([.][0-9]{1,2})?$' THEN 'not a number (use digits and at most two decimals)'
                   WHEN c2.raw::numeric > i.points THEN format('more than the maximum of %s', i.points)
                 END AS err
            FROM lms.mark_import_cells c2
            LEFT JOIN lms.gradebook_items i ON i.tenant_id = p_tenant AND i.gradebook_id = g.id
                                           AND i.source = 'manual' AND i.archived_at IS NULL
                                           AND lower(i.title) = lower(btrim(c2.column_name))
            LEFT JOIN (SELECT p.id AS pid, mp.register_number
                         FROM lms.course_participants p
                         JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = p.membership_id
                        WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner'
                          AND p.status = 'active') pp ON pp.register_number = c2.register_number
           WHERE c2.tenant_id = p_tenant AND c2.import_id = imp) x
   WHERE c.tenant_id = p_tenant AND c.import_id = imp AND c.row_no = x.row_no AND c.cell_no = x.cell_no;
  RETURN lms.gradebook_import_summary(p_tenant, imp);
END
$$;

CREATE FUNCTION lms.gradebook_import_summary(p_tenant uuid, p_import uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object(
    'result', 'ok', 'importId', m.id, 'status', m.status, 'rows', m.row_count,
    'cells', (SELECT count(*) FROM lms.mark_import_cells c WHERE c.tenant_id = m.tenant_id AND c.import_id = m.id),
    'errorCells', (SELECT count(*) FROM lms.mark_import_cells c WHERE c.tenant_id = m.tenant_id AND c.import_id = m.id AND c.error IS NOT NULL),
    'errorRows', (SELECT count(DISTINCT c.row_no) FROM lms.mark_import_cells c WHERE c.tenant_id = m.tenant_id AND c.import_id = m.id AND c.error IS NOT NULL),
    'unknownColumns', (SELECT coalesce(jsonb_agg(DISTINCT c.column_name), '[]'::jsonb) FROM lms.mark_import_cells c
                        WHERE c.tenant_id = m.tenant_id AND c.import_id = m.id AND c.item_id IS NULL),
    'errors', (SELECT coalesce(jsonb_agg(jsonb_build_object('row', x.row_no, 'register', x.register_number, 'column', x.column_name,
                         'value', x.raw, 'error', x.error) ORDER BY x.row_no, x.cell_no), '[]'::jsonb)
                 FROM (SELECT * FROM lms.mark_import_cells c WHERE c.tenant_id = m.tenant_id AND c.import_id = m.id
                          AND c.error IS NOT NULL ORDER BY c.row_no, c.cell_no LIMIT 200) x))
    FROM lms.mark_imports m WHERE m.tenant_id = p_tenant AND m.id = p_import
$$;

CREATE FUNCTION lms.gradebook_import_get(p_tenant uuid, p_offering uuid, p_import uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT lms.gradebook_import_summary(m.tenant_id, m.id)
    FROM lms.mark_imports m JOIN lms.gradebooks g ON g.tenant_id = m.tenant_id AND g.id = m.gradebook_id
   WHERE m.tenant_id = p_tenant AND m.id = p_import AND g.offering_id = p_offering
$$;

CREATE FUNCTION lms.gradebook_import_apply(p_tenant uuid, p_user uuid, p_offering uuid, p_all_items boolean, p_import uuid,
                                           p_skip_invalid boolean)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  m lms.mark_imports;
  errs integer;
  skipped integer;
  res jsonb;
BEGIN
  SELECT mi.* INTO m FROM lms.mark_imports mi JOIN lms.gradebooks g ON g.tenant_id = mi.tenant_id AND g.id = mi.gradebook_id
   WHERE mi.tenant_id = p_tenant AND mi.id = p_import AND g.offering_id = p_offering FOR UPDATE OF mi;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF m.status <> 'staged' THEN RETURN jsonb_build_object('result', 'import_done'); END IF;
  SELECT count(*) INTO errs FROM lms.mark_import_cells WHERE tenant_id = p_tenant AND import_id = p_import AND error IS NOT NULL;
  SELECT count(DISTINCT row_no) INTO skipped FROM lms.mark_import_cells
   WHERE tenant_id = p_tenant AND import_id = p_import AND error IS NOT NULL;
  IF errs > 0 AND NOT p_skip_invalid THEN
    RETURN jsonb_build_object('result', 'has_errors', 'errorCells', errs);
  END IF;
  -- a row with any error is skipped as a whole
  res := lms.gradebook_marks_save(p_tenant, p_user, p_offering, p_all_items, 'import',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', c.item_id, 'participantId', c.participant_id, 'points', c.points::text)), '[]'::jsonb)
       FROM lms.mark_import_cells c
      WHERE c.tenant_id = p_tenant AND c.import_id = p_import AND c.item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lms.mark_import_cells e WHERE e.tenant_id = p_tenant AND e.import_id = p_import
                           AND e.row_no = c.row_no AND e.error IS NOT NULL)));
  IF res ->> 'result' <> 'ok' THEN RETURN res; END IF;
  UPDATE lms.mark_imports SET status = 'applied' WHERE tenant_id = p_tenant AND id = p_import;
  DELETE FROM lms.mark_import_cells WHERE tenant_id = p_tenant AND import_id = p_import;
  RETURN res || jsonb_build_object('skippedRows', skipped);
END
$$;

-- staged imports nobody applied are removed after p_hours
CREATE FUNCTION lms.gradebook_purge_imports(p_hours integer, p_limit integer)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH d AS (DELETE FROM lms.mark_imports m WHERE m.id IN (
               SELECT id FROM lms.mark_imports WHERE created_at < now() - make_interval(hours => p_hours)
                ORDER BY created_at LIMIT least(p_limit, 10000)) RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

-- ------------------------------------------------------------------ overrides
-- p_item NULL: an override of the FINAL marks. Setting a new one revokes the previous (history stays).
CREATE FUNCTION lms.gradebook_override_set(p_tenant uuid, p_user uuid, p_offering uuid, p_participant uuid, p_item uuid,
                                           p_points numeric, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  old lms.grade_overrides;
  mx numeric;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.course_participants p WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering
                  AND p.id = p_participant AND p.participation = 'learner' AND p.status = 'active') THEN
    RETURN jsonb_build_object('result', 'bad_participant');
  END IF;
  IF p_item IS NOT NULL THEN
    SELECT i.points INTO mx FROM lms.gradebook_items i
     WHERE i.tenant_id = p_tenant AND i.gradebook_id = g.id AND i.id = p_item AND i.archived_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'bad_item'); END IF;
  ELSE
    mx := g.out_of;
  END IF;
  IF p_points < 0 OR p_points > mx OR scale(p_points) > 2 THEN
    RETURN jsonb_build_object('result', 'bad_value', 'max', mx);
  END IF;
  SELECT * INTO old FROM lms.grade_overrides o
   WHERE o.tenant_id = p_tenant AND o.participant_id = p_participant AND o.revoked_at IS NULL
     AND o.gradebook_id = g.id AND o.item_id IS NOT DISTINCT FROM p_item;
  IF FOUND THEN
    UPDATE lms.grade_overrides SET revoked_at = now(), revoked_by = p_user WHERE tenant_id = p_tenant AND id = old.id;
  END IF;
  INSERT INTO lms.grade_overrides (id, tenant_id, gradebook_id, participant_id, item_id, points, reason, set_by)
  VALUES (lms.uuid_v7(), p_tenant, g.id, p_participant, p_item, p_points, btrim(p_reason), p_user);
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.override_set', g.id, jsonb_build_object(
    'offeringId', p_offering, 'participantId', p_participant, 'itemId', p_item, 'reason', btrim(p_reason),
    'before', CASE WHEN old.id IS NOT NULL THEN old.points END, 'after', p_points));
  RETURN jsonb_build_object('result', 'ok');
END
$$;

CREATE FUNCTION lms.gradebook_override_revoke(p_tenant uuid, p_user uuid, p_offering uuid, p_participant uuid, p_item uuid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  old lms.grade_overrides;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  SELECT * INTO old FROM lms.grade_overrides o
   WHERE o.tenant_id = p_tenant AND o.participant_id = p_participant AND o.revoked_at IS NULL
     AND o.gradebook_id = g.id AND o.item_id IS NOT DISTINCT FROM p_item;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'no_override'); END IF;
  UPDATE lms.grade_overrides SET revoked_at = now(), revoked_by = p_user WHERE tenant_id = p_tenant AND id = old.id;
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.override_revoked', g.id, jsonb_build_object(
    'offeringId', p_offering, 'participantId', p_participant, 'itemId', p_item, 'before', old.points));
  RETURN jsonb_build_object('result', 'ok');
END
$$;

-- ------------------------------------------------------------------ the approval workflow
-- What stops a gradebook from being submitted / approved. Each problem: {code, message, items?}.
CREATE FUNCTION lms.gradebook_problems(p_tenant uuid, p_gb uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  WITH g AS (SELECT * FROM lms.gradebooks WHERE tenant_id = p_tenant AND id = p_gb),
  its AS (
    SELECT i.id, i.source, i.content_item_id, i.category_id, i.extra_credit, i.released,
           coalesce(i.title, ci.title) AS title
      FROM lms.gradebook_items i LEFT JOIN lms.content_items ci ON ci.tenant_id = i.tenant_id AND ci.id = i.content_item_id
     WHERE i.tenant_id = p_tenant AND i.gradebook_id = p_gb AND i.archived_at IS NULL
       AND (i.source = 'manual' OR ci.deleted_at IS NULL)),
  unreleased AS (
    SELECT its.title FROM its
     WHERE (its.source = 'manual' AND NOT its.released
            AND EXISTS (SELECT 1 FROM lms.manual_marks m WHERE m.tenant_id = p_tenant AND m.item_id = its.id))
        OR (its.source = 'assessment' AND EXISTS (
              SELECT 1 FROM lms.gradebook_assessment_scores(p_tenant, (SELECT offering_id FROM g)) f
               WHERE f.item_id = its.content_item_id AND NOT f.released))
        OR (its.source = 'assignment' AND EXISTS (
              SELECT 1 FROM lms.assignment_final_scores(p_tenant, (SELECT offering_id FROM g)) f
               WHERE f.item_id = its.content_item_id AND NOT f.released))),
  wsum AS (
    SELECT coalesce(sum(c.weight), 0) AS w FROM lms.gradebook_categories c
     WHERE c.tenant_id = p_tenant AND c.gradebook_id = p_gb
       AND EXISTS (SELECT 1 FROM its WHERE its.category_id = c.id AND NOT its.extra_credit))
  SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('code', 'no_items', 'message', 'Add at least one item to the gradebook') AS p
      WHERE NOT EXISTS (SELECT 1 FROM its WHERE NOT its.extra_credit)
    UNION ALL
    SELECT jsonb_build_object('code', 'weights', 'message',
             format('The weights of the categories add up to %s, not 100', (SELECT w FROM wsum)))
      FROM g WHERE g.weighted AND (SELECT w FROM wsum) <> 100
    UNION ALL
    SELECT jsonb_build_object('code', 'no_scale', 'message', 'Choose a grade scale') FROM g WHERE g.scale_id IS NULL
    UNION ALL
    SELECT jsonb_build_object('code', 'unreleased', 'message',
             'These items have marks that learners cannot see yet. Release them before submitting.',
             'items', (SELECT jsonb_agg(u.title ORDER BY u.title) FROM unreleased u))
      WHERE EXISTS (SELECT 1 FROM unreleased)) x
$$;

-- learners who are NOT part of a snapshot (removed from the offering or from the college), each with the reason
CREATE FUNCTION lms.gradebook_excluded(p_tenant uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'participantId', p.id, 'name', u.display_name, 'registerNumber', mp.register_number,
           'reason', CASE WHEN tm.status = 'removed' OR p.removed_reason = 'membership' THEN 'removed_from_college'
                          WHEN p.removed_reason = 'manual' THEN 'removed_from_offering'
                          ELSE 'left_the_class' END,
           'hasMarks', EXISTS (SELECT 1 FROM lms.manual_marks m WHERE m.tenant_id = p.tenant_id AND m.participant_id = p.id)
                    OR EXISTS (SELECT 1 FROM lms.attempts a WHERE a.tenant_id = p.tenant_id AND a.offering_id = p.offering_id
                                AND a.participant_id = p.id)
                    OR EXISTS (SELECT 1 FROM lms.submissions s WHERE s.tenant_id = p.tenant_id AND s.offering_id = p.offering_id
                                AND s.participant_id = p.id))
           ORDER BY u.display_name, p.id), '[]'::jsonb)
    FROM lms.course_participants p
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.users u ON u.id = tm.user_id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner'
     AND (p.status = 'removed' OR tm.status = 'removed')
$$;

CREATE FUNCTION lms.gradebook_submit(p_tenant uuid, p_user uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  probs jsonb;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status NOT IN ('draft', 'returned') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', g.status);
  END IF;
  probs := lms.gradebook_problems(p_tenant, g.id);
  IF jsonb_array_length(probs) > 0 THEN RETURN jsonb_build_object('result', 'not_ready', 'problems', probs); END IF;
  UPDATE lms.gradebooks SET status = 'submitted', submitted_by = p_user, submitted_at = now(), review_comment = NULL,
         updated_at = now() WHERE id = g.id;
  INSERT INTO lms.gradebook_events (id, tenant_id, gradebook_id, version_no, action, actor_user_id)
  VALUES (lms.uuid_v7(), p_tenant, g.id, g.version_no, 'submitted', p_user);
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.submitted', g.id,
                       jsonb_build_object('offeringId', p_offering, 'versionNo', g.version_no));
  RETURN jsonb_build_object('result', 'ok', 'versionNo', g.version_no);
END
$$;

-- The approver may not be the submitter unless the college allows it. The refusal is audited (and committed: it is a
-- normal return, not an error).
CREATE FUNCTION lms.gradebook_review_action(p_tenant uuid, p_user uuid, p_offering uuid, p_action text, p_comment text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  g lms.gradebooks;
  own boolean;
  probs jsonb;
  vid uuid := lms.uuid_v7();
  n integer;
  excl jsonb;
  included uuid[];
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status <> 'submitted' THEN RETURN jsonb_build_object('result', 'not_submitted', 'status', g.status); END IF;
  own := g.submitted_by = p_user;
  IF own AND NOT lms.gb_self_approval(p_tenant) THEN
    PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.self_approval_refused', g.id,
                         jsonb_build_object('offeringId', p_offering, 'attempted', p_action));
    RETURN jsonb_build_object('result', 'self_approval');
  END IF;
  IF p_action = 'return' THEN
    UPDATE lms.gradebooks SET status = 'returned', review_comment = p_comment, updated_at = now() WHERE id = g.id;
    INSERT INTO lms.gradebook_events (id, tenant_id, gradebook_id, version_no, action, actor_user_id, self_approved, comment)
    VALUES (lms.uuid_v7(), p_tenant, g.id, g.version_no, 'returned', p_user, own, p_comment);
    PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.returned', g.id,
                         jsonb_build_object('offeringId', p_offering, 'versionNo', g.version_no, 'selfReview', own, 'comment', p_comment));
    RETURN jsonb_build_object('result', 'ok', 'versionNo', g.version_no);
  END IF;
  -- approve: check again (items may have been unreleased since), then freeze everything in this statement
  probs := lms.gradebook_problems(p_tenant, g.id);
  IF jsonb_array_length(probs) > 0 THEN RETURN jsonb_build_object('result', 'not_ready', 'problems', probs); END IF;
  excl := lms.gradebook_excluded(p_tenant, p_offering);
  SELECT coalesce(array_agg(p.id), ARRAY[]::uuid[]) INTO included
    FROM lms.course_participants p JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner' AND p.status = 'active'
     AND tm.status <> 'removed';
  INSERT INTO lms.gradebook_versions (id, tenant_id, gradebook_id, version_no, config, excluded, learner_count,
                                      submitted_by, approved_by, self_approved)
  VALUES (vid, p_tenant, g.id, g.version_no, lms.gradebook_config_json(p_tenant, g.id), excl,
          coalesce(array_length(included, 1), 0), g.submitted_by, p_user, own);
  INSERT INTO lms.gradebook_snapshot_rows (tenant_id, version_id, participant_id, register_number, display_name, email,
                                           section_code, sort_key, cells, cats, final_marks, final_percent, grade, is_pass,
                                           overridden, explanation)
  SELECT p_tenant, vid, r.participant_id, mp.register_number, u.display_name, u.email, sec.code,
         coalesce(mp.register_number, '~'), r.cells, r.cats, r.final_marks, r.final_percent, r.grade, r.is_pass,
         r.overridden, r.explanation
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', included, true) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.users u ON u.id = tm.user_id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE lms.gradebooks SET status = 'locked', review_comment = p_comment, updated_at = now() WHERE id = g.id;
  INSERT INTO lms.gradebook_events (id, tenant_id, gradebook_id, version_no, action, actor_user_id, self_approved, comment)
  VALUES (lms.uuid_v7(), p_tenant, g.id, g.version_no, 'approved', p_user, own, p_comment);
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.approved', g.id, jsonb_build_object(
    'offeringId', p_offering, 'versionNo', g.version_no, 'selfApproved', own, 'learners', n,
    'excluded', jsonb_array_length(excl)));
  RETURN jsonb_build_object('result', 'ok', 'versionNo', g.version_no, 'learners', n);
END
$$;

CREATE FUNCTION lms.gradebook_unlock(p_tenant uuid, p_user uuid, p_offering uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE g lms.gradebooks;
BEGIN
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF g.status <> 'locked' THEN RETURN jsonb_build_object('result', 'not_locked', 'status', g.status); END IF;
  UPDATE lms.gradebooks SET status = 'draft', version_no = g.version_no + 1, submitted_by = NULL, submitted_at = NULL,
         review_comment = NULL, updated_at = now() WHERE id = g.id;
  INSERT INTO lms.gradebook_events (id, tenant_id, gradebook_id, version_no, action, actor_user_id, comment)
  VALUES (lms.uuid_v7(), p_tenant, g.id, g.version_no, 'unlocked', p_user, p_reason);
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.unlocked', g.id, jsonb_build_object(
    'offeringId', p_offering, 'lockedVersionNo', g.version_no, 'newVersionNo', g.version_no + 1, 'reason', p_reason));
  RETURN jsonb_build_object('result', 'ok', 'versionNo', g.version_no + 1);
END
$$;

-- everything the approver needs to decide: the structure, the problems, who is not in the snapshot, the outcome in numbers
CREATE FUNCTION lms.gradebook_review(p_tenant uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT lms.gradebook_config(p_tenant, p_offering) || jsonb_build_object(
    'problems', lms.gradebook_problems(p_tenant, g.id),
    'excluded', lms.gradebook_excluded(p_tenant, p_offering),
    'stats', (SELECT jsonb_build_object(
                'learners', count(*), 'withFinal', count(r.final_marks), 'overridden', count(*) FILTER (WHERE r.overridden),
                'average', round(avg(r.final_marks), 2), 'min', min(r.final_marks), 'max', max(r.final_marks),
                'failing', count(*) FILTER (WHERE r.is_pass = false),
                'grades', (SELECT coalesce(jsonb_object_agg(x.grade, x.n), '{}'::jsonb)
                             FROM (SELECT r2.grade, count(*) AS n FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', NULL, false) r2
                                    WHERE r2.grade IS NOT NULL GROUP BY r2.grade) x))
                FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', NULL, false) r))
    FROM lms.gradebooks g WHERE g.tenant_id = p_tenant AND g.offering_id = p_offering
$$;

-- the approval queue across the college's offerings
CREATE FUNCTION lms.gradebook_queue(p_tenant uuid, p_status text, p_after_at timestamptz, p_after_id uuid, p_limit integer)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'gradebookId', x.id, 'offeringId', x.offering_id, 'courseCode', x.code, 'courseTitle', x.title, 'termName', x.term_name,
           'label', x.label, 'status', x.status, 'versionNo', x.version_no, 'submittedAt', x.submitted_at,
           'submittedBy', x.submitted_by_name, 'updatedAt', x.updated_at, 'sortAt', x.sort_at) ORDER BY x.sort_at DESC, x.id DESC), '[]'::jsonb)
    FROM (SELECT g.id, g.offering_id, c.code, c.title, t.name AS term_name, o.label, g.status, g.version_no, g.submitted_at, g.updated_at,
                 coalesce(g.submitted_at, g.updated_at) AS sort_at,
                 (SELECT u.display_name FROM lms.users u WHERE u.id = g.submitted_by) AS submitted_by_name
            FROM lms.gradebooks g
            JOIN lms.course_offerings o ON o.tenant_id = g.tenant_id AND o.id = g.offering_id
            JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
            JOIN lms.terms t ON t.tenant_id = o.tenant_id AND t.id = o.term_id
           WHERE g.tenant_id = p_tenant AND g.status = p_status
             AND (p_after_at IS NULL OR (coalesce(g.submitted_at, g.updated_at), g.id) < (p_after_at, p_after_id))
           ORDER BY coalesce(g.submitted_at, g.updated_at) DESC, g.id DESC LIMIT p_limit) x
$$;

-- ------------------------------------------------------------------ snapshots (read)
CREATE FUNCTION lms.gradebook_snapshot_meta(p_tenant uuid, p_offering uuid, p_version integer)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'config', v.config, 'excluded', v.excluded,
           'learnerCount', v.learner_count, 'lockedAt', v.locked_at, 'selfApproved', v.self_approved,
           'approvedBy', (SELECT u.display_name FROM lms.users u WHERE u.id = v.approved_by),
           'exportLayout', g.export_layout, 'offeringId', g.offering_id)
    FROM lms.gradebook_versions v JOIN lms.gradebooks g ON g.tenant_id = v.tenant_id AND g.id = v.gradebook_id
   WHERE v.tenant_id = p_tenant AND g.offering_id = p_offering
     AND v.version_no = coalesce(p_version, (SELECT max(v2.version_no) FROM lms.gradebook_versions v2
                                               WHERE v2.tenant_id = p_tenant AND v2.gradebook_id = g.id))
$$;

CREATE FUNCTION lms.gradebook_snapshot_page(p_tenant uuid, p_version_id uuid, p_after_sk text, p_after_id uuid, p_limit integer,
                                            p_with_explanation boolean)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'participantId', s.participant_id, 'registerNumber', s.register_number, 'name', s.display_name, 'email', s.email,
           'section', s.section_code, 'sortKey', s.sort_key, 'cells', s.cells, 'cats', s.cats, 'finalMarks', s.final_marks,
           'finalPercent', s.final_percent, 'grade', s.grade, 'isPass', s.is_pass, 'overridden', s.overridden)
           || CASE WHEN p_with_explanation THEN jsonb_build_object('explanation', s.explanation) ELSE '{}'::jsonb END
           ORDER BY s.sort_key COLLATE "C", s.participant_id), '[]'::jsonb)
    FROM (SELECT * FROM lms.gradebook_snapshot_rows r
           WHERE r.tenant_id = p_tenant AND r.version_id = p_version_id
             AND (p_after_sk IS NULL OR (r.sort_key COLLATE "C", r.participant_id) > (p_after_sk COLLATE "C", p_after_id))
           ORDER BY r.sort_key COLLATE "C", r.participant_id LIMIT p_limit) s
$$;

-- ------------------------------------------------------------------ the learner (definer, autocommit, 2 round trips)
-- Locked and approved: the learner sees the frozen record. Otherwise: the provisional figures from RELEASED items only.
CREATE FUNCTION lms.gradebook_me(p_tenant uuid, p_user uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  part uuid;
  parts text[];
  g lms.gradebooks;
  snap lms.gradebook_snapshot_rows;
  vid uuid;
  prev integer;
  r record;
BEGIN
  SELECT p.id INTO part
    FROM lms.course_participants p
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND tm.user_id = p_user AND p.participation = 'learner'
     AND p.status = 'active' AND tm.status = 'active' AND o.status = 'published';
  IF part IS NULL THEN
    SELECT array_agg(DISTINCT p.participation::text) INTO parts
      FROM lms.course_participants p
      JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
      JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
     WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND tm.user_id = p_user AND p.status = 'active'
       AND tm.status = 'active' AND (p.participation <> 'learner' OR o.status = 'published');
    RETURN jsonb_build_object('result', CASE WHEN parts IS NULL THEN 'no_offering'
                                             WHEN 'learner' = ANY (parts) THEN 'not_visible' ELSE 'forbidden' END);
  END IF;
  SELECT * INTO g FROM lms.gradebooks WHERE tenant_id = p_tenant AND offering_id = p_offering;
  SELECT max(v.version_no) INTO prev FROM lms.gradebook_versions v WHERE v.tenant_id = p_tenant AND v.gradebook_id = g.id;
  IF g.status = 'locked' THEN
    SELECT v.id INTO vid FROM lms.gradebook_versions v
     WHERE v.tenant_id = p_tenant AND v.gradebook_id = g.id AND v.version_no = g.version_no;
    SELECT * INTO snap FROM lms.gradebook_snapshot_rows s WHERE s.tenant_id = p_tenant AND s.version_id = vid AND s.participant_id = part;
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'ok', 'status', 'locked', 'provisional', false, 'underRevision', false,
        'versionNo', g.version_no, 'final', jsonb_build_object('marks', snap.final_marks, 'percent', snap.final_percent,
           'grade', snap.grade, 'isPass', snap.is_pass),
        'explanation', snap.explanation);
    END IF;
  END IF;
  SELECT * INTO r FROM lms.gradebook_compute(p_tenant, p_offering, 'learner', ARRAY[part], true);
  RETURN jsonb_build_object('result', 'ok', 'status', g.status, 'provisional', true,
    'underRevision', (g.status <> 'locked' AND prev IS NOT NULL),
    'notInSnapshot', (g.status = 'locked'),
    'versionNo', g.version_no, 'previousVersionNo', prev,
    'final', jsonb_build_object('marks', r.final_marks, 'percent', r.final_percent, 'grade', NULL, 'isPass', NULL),
    'explanation', (r.explanation - 'grade' - 'isPass'));
END
$$;

-- ------------------------------------------------------------------ grade scales (college templates)
CREATE FUNCTION lms.grade_scale_json(p_tenant uuid, p_scale uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', s.id, 'name', s.name, 'archived', s.archived_at IS NOT NULL,
           'bands', (SELECT coalesce(jsonb_agg(jsonb_build_object('minPercent', b.min_percent, 'label', b.label,
                        'gradePoints', b.grade_points, 'isPass', b.is_pass) ORDER BY b.min_percent DESC), '[]'::jsonb)
                       FROM lms.grade_scale_bands b WHERE b.tenant_id = s.tenant_id AND b.scale_id = s.id),
           'offerings', (SELECT count(*) FROM lms.gradebooks g WHERE g.tenant_id = s.tenant_id AND g.scale_id = s.id))
    FROM lms.grade_scales s WHERE s.tenant_id = p_tenant AND s.id = p_scale
$$;

CREATE FUNCTION lms.grade_scales_list(p_tenant uuid, p_include_archived boolean)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(lms.grade_scale_json(s.tenant_id, s.id) ORDER BY s.name, s.id), '[]'::jsonb)
    FROM lms.grade_scales s WHERE s.tenant_id = p_tenant AND (p_include_archived OR s.archived_at IS NULL)
$$;

-- p_scale: {id?, name, bands: [{minPercent, label, gradePoints?, isPass}]}. A scale in use by a locked gradebook keeps
-- working: the snapshot holds its own copy of the bands.
CREATE FUNCTION lms.grade_scale_save(p_tenant uuid, p_user uuid, p_scale jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  sid uuid;
  b jsonb;
  existed boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_scale -> 'bands') x WHERE (x ->> 'minPercent')::numeric = 0) THEN
    RETURN jsonb_build_object('result', 'invalid', 'details',
      jsonb_build_array(jsonb_build_object('path', 'bands', 'message', 'the lowest band must start at 0 percent')));
  END IF;
  IF (SELECT count(DISTINCT (x ->> 'minPercent')::numeric) FROM jsonb_array_elements(p_scale -> 'bands') x)
     <> jsonb_array_length(p_scale -> 'bands')
     OR (SELECT count(DISTINCT lower(x ->> 'label')) FROM jsonb_array_elements(p_scale -> 'bands') x)
     <> jsonb_array_length(p_scale -> 'bands') THEN
    RETURN jsonb_build_object('result', 'invalid', 'details',
      jsonb_build_array(jsonb_build_object('path', 'bands', 'message', 'bands need different start percentages and different labels')));
  END IF;
  IF p_scale ->> 'id' IS NOT NULL THEN
    sid := (p_scale ->> 'id')::uuid;
    SELECT true INTO existed FROM lms.grade_scales WHERE tenant_id = p_tenant AND id = sid FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
    UPDATE lms.grade_scales SET name = btrim(p_scale ->> 'name'), updated_at = now() WHERE tenant_id = p_tenant AND id = sid;
    DELETE FROM lms.grade_scale_bands WHERE tenant_id = p_tenant AND scale_id = sid;
  ELSE
    sid := lms.uuid_v7();
    INSERT INTO lms.grade_scales (id, tenant_id, name, created_by) VALUES (sid, p_tenant, btrim(p_scale ->> 'name'), p_user);
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(p_scale -> 'bands') x LOOP
    INSERT INTO lms.grade_scale_bands (tenant_id, scale_id, min_percent, label, grade_points, is_pass)
    VALUES (p_tenant, sid, (b ->> 'minPercent')::numeric, btrim(b ->> 'label'), (b ->> 'gradePoints')::numeric,
            coalesce((b ->> 'isPass')::boolean, true));
  END LOOP;
  PERFORM lms.gb_audit(p_tenant, p_user, CASE WHEN existed THEN 'gradebook.scale_updated' ELSE 'gradebook.scale_created' END, sid,
                       jsonb_build_object('name', btrim(p_scale ->> 'name'), 'bands', p_scale -> 'bands'));
  RETURN jsonb_build_object('result', 'ok', 'id', sid, 'scale', lms.grade_scale_json(p_tenant, sid));
END
$$;

CREATE FUNCTION lms.grade_scale_archive(p_tenant uuid, p_user uuid, p_scale uuid, p_archived boolean)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.grade_scales SET archived_at = CASE WHEN p_archived THEN now() END, updated_at = now()
   WHERE tenant_id = p_tenant AND id = p_scale;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM lms.gb_audit(p_tenant, p_user, 'gradebook.scale_archived', p_scale, jsonb_build_object('archived', p_archived));
  RETURN jsonb_build_object('result', 'ok', 'scale', lms.grade_scale_json(p_tenant, p_scale));
END
$$;

-- ------------------------------------------------------------------ grants
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'gb_audit(uuid, uuid, text, uuid, jsonb)', 'gb_self_approval(uuid)', 'gradebook_config_json(uuid, uuid)',
    'gradebook_config(uuid, uuid)', 'gradebook_settings_update(uuid, uuid, uuid, jsonb)',
    'gradebook_categories_save(uuid, uuid, uuid, jsonb)', 'gradebook_items_save(uuid, uuid, uuid, jsonb)',
    'gradebook_grid(uuid, uuid, uuid, text, uuid, integer)', 'gradebook_explain(uuid, uuid, uuid)',
    'gradebook_marks_save(uuid, uuid, uuid, boolean, text, jsonb)',
    'gradebook_import_stage(uuid, uuid, uuid, boolean, integer, jsonb)', 'gradebook_import_summary(uuid, uuid)',
    'gradebook_import_get(uuid, uuid, uuid)', 'gradebook_import_apply(uuid, uuid, uuid, boolean, uuid, boolean)',
    'gradebook_purge_imports(integer, integer)',
    'gradebook_override_set(uuid, uuid, uuid, uuid, uuid, numeric, text)',
    'gradebook_override_revoke(uuid, uuid, uuid, uuid, uuid)', 'gradebook_problems(uuid, uuid)',
    'gradebook_excluded(uuid, uuid)', 'gradebook_submit(uuid, uuid, uuid)',
    'gradebook_review_action(uuid, uuid, uuid, text, text)', 'gradebook_unlock(uuid, uuid, uuid, text)',
    'gradebook_review(uuid, uuid)', 'gradebook_queue(uuid, text, timestamptz, uuid, integer)',
    'gradebook_snapshot_meta(uuid, uuid, integer)', 'gradebook_snapshot_page(uuid, uuid, text, uuid, integer, boolean)',
    'gradebook_me(uuid, uuid, uuid)', 'grade_scale_json(uuid, uuid)', 'grade_scales_list(uuid, boolean)', 'grade_scale_save(uuid, uuid, jsonb)',
    'grade_scale_archive(uuid, uuid, uuid, boolean)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION lms.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lms.%s TO lms_app', f);
  END LOOP;
END
$$;

-- Step 14b-1, part 1b: every FUNCTION that shows a member's name or address inside a college reads lms.member_identity (migration 0060).
--
-- Recreated here (CREATE OR REPLACE: the owner, the grants and the body's callers are untouched; only the lines that read lms.users change):
--   gradebook_config, gradebook_explain, gradebook_excluded, gradebook_queue, gradebook_snapshot_meta, gradebook_grid,
--   gradebook_review_action (the approval writes the snapshot rows: a member erased before approval is snapshotted under the pseudonym),
--   email_suppressions_for_tenant.
-- NOT changed, on purpose (their reason is in test/identity-readers.unit.test.ts): sign-in and session lookup, invite / reset flows, mail
-- delivery (it needs the live address), the platform functions, imports (they match by address), gradebook_snapshot_page (the frozen
-- record keeps what it recorded: the approved gradebook is the college's academic record; counsel decides, docs/data-retention.md).
--
-- Every function keeps its SET clauses: search_path, and for the grid and the approval enable_nestloop = off and jit = off (migrations
-- 0042 / 0056; function-jit.test.ts). The migration CHECKS this itself: it records proconfig, the ACL, SECURITY DEFINER and volatility of every
-- function it replaces before it starts and raises if one differs afterwards (the migration fails and rolls back; nothing is half applied).

CREATE TEMP TABLE _identity_fn_before ON COMMIT DROP AS
SELECT p.oid::regprocedure::text AS sig,
       (SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c) AS cfg,
       coalesce(p.proacl::text, '') AS acl, p.prosecdef, p.provolatile, p.proowner::regrole::text AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'lms'
   AND p.proname IN ('gradebook_config', 'gradebook_explain', 'gradebook_excluded', 'gradebook_queue', 'gradebook_snapshot_meta',
                     'gradebook_grid', 'gradebook_review_action', 'email_suppressions_for_tenant');

DO $$
BEGIN
  IF (SELECT count(*) FROM _identity_fn_before) <> 8 THEN
    RAISE EXCEPTION 'expected 8 functions to replace, found %', (SELECT count(*) FROM _identity_fn_before);
  END IF;
END
$$;

-- gradebook_config
CREATE OR REPLACE FUNCTION lms.gradebook_config(p_tenant uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT lms.gradebook_config_json(p_tenant, g.id)
         || jsonb_build_object(
           'id', g.id, 'offeringId', g.offering_id, 'status', g.status, 'versionNo', g.version_no,
           'exportLayout', g.export_layout, 'submittedAt', g.submitted_at, 'reviewComment', g.review_comment,
           'submittedBy', (SELECT u.display_name FROM lms.member_identity u WHERE u.tenant_id = p_tenant AND u.user_id = g.submitted_by),
           'selfApprovalAllowed', lms.gb_self_approval(g.tenant_id),
           'lockedVersions', (SELECT coalesce(jsonb_agg(jsonb_build_object('versionNo', v.version_no, 'lockedAt', v.locked_at,
                                      'learnerCount', v.learner_count, 'excluded', v.excluded, 'selfApproved', v.self_approved,
                                      'approvedBy', (SELECT u.display_name FROM lms.member_identity u WHERE u.tenant_id = p_tenant AND u.user_id = v.approved_by))
                                      ORDER BY v.version_no DESC), '[]'::jsonb)
                                FROM lms.gradebook_versions v WHERE v.tenant_id = g.tenant_id AND v.gradebook_id = g.id),
           'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'at', e.created_at,
                               'by', (SELECT u.display_name FROM lms.member_identity u WHERE u.tenant_id = p_tenant AND u.user_id = e.actor_user_id),
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

-- gradebook_explain
CREATE OR REPLACE FUNCTION lms.gradebook_explain(p_tenant uuid, p_offering uuid, p_participant uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object(
           'participantId', r.participant_id, 'name', u.display_name, 'email', u.email,
           'registerNumber', mp.register_number, 'section', sec.code,
           'explanation', r.explanation, 'cells', r.cells,
           'overrides', (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', o.item_id, 'points', o.points, 'reason', o.reason,
                                   'setAt', o.set_at, 'setBy', (SELECT us.display_name FROM lms.member_identity us WHERE us.tenant_id = p_tenant AND us.user_id = o.set_by))
                                   ORDER BY o.set_at), '[]'::jsonb)
                           FROM lms.grade_overrides o JOIN lms.gradebooks g ON g.tenant_id = o.tenant_id AND g.id = o.gradebook_id
                          WHERE o.tenant_id = p_tenant AND g.offering_id = p_offering AND o.participant_id = r.participant_id
                            AND o.revoked_at IS NULL))
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', ARRAY[p_participant], true) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.member_identity u ON u.tenant_id = tm.tenant_id AND u.membership_id = tm.id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id
$$;

-- gradebook_excluded
CREATE OR REPLACE FUNCTION lms.gradebook_excluded(p_tenant uuid, p_offering uuid)
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
    JOIN lms.member_identity u ON u.tenant_id = tm.tenant_id AND u.membership_id = tm.id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner'
     AND (p.status = 'removed' OR tm.status = 'removed')
$$;

-- gradebook_queue
CREATE OR REPLACE FUNCTION lms.gradebook_queue(p_tenant uuid, p_status text, p_after_at timestamptz, p_after_id uuid, p_limit integer)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'gradebookId', x.id, 'offeringId', x.offering_id, 'courseCode', x.code, 'courseTitle', x.title, 'termName', x.term_name,
           'label', x.label, 'status', x.status, 'versionNo', x.version_no, 'submittedAt', x.submitted_at,
           'submittedBy', x.submitted_by_name, 'updatedAt', x.updated_at, 'sortAt', x.sort_at) ORDER BY x.sort_at DESC, x.id DESC), '[]'::jsonb)
    FROM (SELECT g.id, g.offering_id, c.code, c.title, t.name AS term_name, o.label, g.status, g.version_no, g.submitted_at, g.updated_at,
                 coalesce(g.submitted_at, g.updated_at) AS sort_at,
                 (SELECT u.display_name FROM lms.member_identity u WHERE u.tenant_id = p_tenant AND u.user_id = g.submitted_by) AS submitted_by_name
            FROM lms.gradebooks g
            JOIN lms.course_offerings o ON o.tenant_id = g.tenant_id AND o.id = g.offering_id
            JOIN lms.courses c ON c.tenant_id = o.tenant_id AND c.id = o.course_id
            JOIN lms.terms t ON t.tenant_id = o.tenant_id AND t.id = o.term_id
           WHERE g.tenant_id = p_tenant AND g.status = p_status
             AND (p_after_at IS NULL OR (coalesce(g.submitted_at, g.updated_at), g.id) < (p_after_at, p_after_id))
           ORDER BY coalesce(g.submitted_at, g.updated_at) DESC, g.id DESC LIMIT p_limit) x
$$;

-- gradebook_snapshot_meta
CREATE OR REPLACE FUNCTION lms.gradebook_snapshot_meta(p_tenant uuid, p_offering uuid, p_version integer)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'config', v.config, 'excluded', v.excluded,
           'learnerCount', v.learner_count, 'lockedAt', v.locked_at, 'selfApproved', v.self_approved,
           'approvedBy', (SELECT u.display_name FROM lms.member_identity u WHERE u.tenant_id = p_tenant AND u.user_id = v.approved_by),
           'exportLayout', g.export_layout, 'offeringId', g.offering_id)
    FROM lms.gradebook_versions v JOIN lms.gradebooks g ON g.tenant_id = v.tenant_id AND g.id = v.gradebook_id
   WHERE v.tenant_id = p_tenant AND g.offering_id = p_offering
     AND v.version_no = coalesce(p_version, (SELECT max(v2.version_no) FROM lms.gradebook_versions v2
                                               WHERE v2.tenant_id = p_tenant AND v2.gradebook_id = g.id))
$$;

-- gradebook_grid
CREATE OR REPLACE FUNCTION lms.gradebook_grid(p_tenant uuid, p_offering uuid, p_section uuid, p_after_sk text, p_after_id uuid,
                                   p_limit integer)
RETURNS json
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp SET enable_nestloop = off SET jit = off
AS $$
DECLARE
  ids uuid[];
  more boolean;
  total integer := NULL;
  rows_json json;
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
  SELECT coalesce(json_agg(json_build_object(
           'participantId', r.participant_id, 'name', u.display_name, 'email', u.email,
           'registerNumber', mp.register_number, 'section', sec.code,
           'cells', r.cells, 'cats', r.cats, 'finalMarks', r.final_marks, 'finalPercent', r.final_percent,
           'grade', r.grade, 'isPass', r.is_pass, 'overridden', r.overridden)
           ORDER BY coalesce(mp.register_number, '~') COLLATE "C", r.participant_id), '[]'::json),
         (array_agg(coalesce(mp.register_number, '~') || '|' || r.participant_id::text
                    ORDER BY coalesce(mp.register_number, '~') COLLATE "C" DESC, r.participant_id DESC))[1]
    INTO rows_json, last_key
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', ids, false) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.member_identity u ON u.tenant_id = tm.tenant_id AND u.membership_id = tm.id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id;
  RETURN json_build_object('rows', rows_json, 'next', CASE WHEN more THEN last_key END, 'total', total);
END
$$;

-- gradebook_review_action
CREATE OR REPLACE FUNCTION lms.gradebook_review_action(p_tenant uuid, p_user uuid, p_offering uuid, p_action text, p_comment text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp SET enable_nestloop = off SET jit = off
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
         coalesce(mp.register_number, '~'), r.cells::jsonb, r.cats::jsonb, r.final_marks, r.final_percent, r.grade, r.is_pass,
         r.overridden, r.explanation::jsonb
    FROM lms.gradebook_compute(p_tenant, p_offering, 'staff', included, true) r
    JOIN lms.course_participants p ON p.tenant_id = p_tenant AND p.id = r.participant_id
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.member_identity u ON u.tenant_id = tm.tenant_id AND u.membership_id = tm.id
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

-- An institution admin sees the active suppressions of THEIR college's members only. The address is matched on lms.users (it IS the
-- address that bounced); the name comes from the identity view, and an erased member is never listed.
CREATE OR REPLACE FUNCTION lms.email_suppressions_for_tenant(p_tenant uuid, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, email text, reason text, detail text, created_at timestamptz, user_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT s.id, s.email, s.reason, s.detail, s.created_at, mi.user_id, mi.display_name
    FROM lms.email_suppressions s
    JOIN lms.users u ON u.email = s.email
    JOIN lms.member_identity mi ON mi.tenant_id = p_tenant AND mi.user_id = u.id AND NOT mi.erased
    JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.id = mi.membership_id AND m.status <> 'removed'
   WHERE s.cleared_at IS NULL AND (p_after IS NULL OR s.id < p_after)
   ORDER BY s.id DESC
   LIMIT least(greatest(p_limit, 1), 101)
$$;

-- ---------------------------------------------------------------- the self-check
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(b.sig || ' (' ||
           CASE WHEN a.sig IS NULL THEN 'missing'
                WHEN a.cfg IS DISTINCT FROM b.cfg THEN 'proconfig ' || b.cfg::text || ' -> ' || a.cfg::text
                WHEN a.acl IS DISTINCT FROM b.acl THEN 'acl ' || b.acl || ' -> ' || a.acl
                WHEN a.prosecdef IS DISTINCT FROM b.prosecdef THEN 'security definer changed'
                WHEN a.provolatile IS DISTINCT FROM b.provolatile THEN 'volatility changed'
                ELSE 'owner changed' END || ')', '; ')
    INTO bad
    FROM _identity_fn_before b
    LEFT JOIN (SELECT p.oid::regprocedure::text AS sig,
                      (SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c) AS cfg,
                      coalesce(p.proacl::text, '') AS acl, p.prosecdef, p.provolatile, p.proowner::regrole::text AS owner
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms') a ON a.sig = b.sig
   WHERE a.sig IS NULL OR a.cfg IS DISTINCT FROM b.cfg OR a.acl IS DISTINCT FROM b.acl OR a.prosecdef IS DISTINCT FROM b.prosecdef
      OR a.provolatile IS DISTINCT FROM b.provolatile OR a.owner IS DISTINCT FROM b.owner;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a replaced function lost a setting or a grant: %', bad;
  END IF;
END
$$;

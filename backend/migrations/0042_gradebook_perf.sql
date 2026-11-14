-- Step 11b: the gradebook calculation, faster (profile and numbers: docs/benchmarks.md "Step 11b", ADR 0019).
--
-- Migrations 0040 and 0041 were committed before this work, so they stay exactly as committed (a migration that exists in any commit
-- is never edited): this one replaces the functions. The result of the calculation is unchanged (the property tests against the
-- BigInt reference pass without a change); what changes is the shape of the statement and the type it returns:
--  * `gradebook_compute` and `gradebook_grid` return `json`, not `jsonb` (no key sorting or parsing of 30,000 cells). A different
--    return type cannot be replaced in place, so both are dropped and created again (nothing depends on them: SQL / plpgsql bodies
--    are not dependency-tracked) and their grants are given again below.
--  * the functions that read the output of the calculation (me, review_action) cast it to jsonb where they need to.
--  * the function-level planner settings (SET ...) are explained at each function.

DROP FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean);
DROP FUNCTION lms.gradebook_grid(uuid, uuid, uuid, text, uuid, integer);

-- ------------------------------------------------------------------ the calculation
-- p_mode 'staff': every score counts, overrides apply. 'learner': only RELEASED items count (an unreleased item behaves as
-- if it did not exist: no state, no mention), final overrides are ignored. p_participants NULL = every active learner.
-- States of a cell: s scored, o overridden, z counted as zero (missing, policy), x missing and left out, p work handed in
-- but not graded yet (left out), h hidden from the learner (left out).
-- Items of an archived or deleted content item are not part of the gradebook.
--
-- SHAPE OF THE STATEMENT (measured, docs/benchmarks.md Step 11b):
--  * every source of marks is read only for the learners asked for and the items of the gradebook (a one-learner call does not
--    scan the class), and the cells are built per SOURCE (manual / assessment / assignment) so a manual cell joins one table;
--  * the cells, the sums and the explanation travel as `json` (text), not `jsonb`: no key sorting or parsing of 30,000 cells;
--  * plpgsql with the plan cached per session: the 25-step statement is planned once, not on every call;
--  * the exact fractions are added per (learner, category, denominator) with native sum(): the fraction aggregate sees a handful
--    of rows, not one per cell.
CREATE FUNCTION lms.gradebook_compute(
  p_tenant uuid, p_offering uuid, p_mode text, p_participants uuid[], p_explain boolean)
RETURNS TABLE (participant_id uuid, cells json, cats json, final_marks numeric, final_percent numeric,
               grade text, is_pass boolean, overridden boolean, explanation json)
-- enable_nestloop = off, and why (measured, ADR 0019): in a college that was just loaded there are NO statistics, the planner believes
-- every CTE holds a handful of rows and joins the 30,000 cells to them with nested loops: 37 s for one call instead of 0.5 s. Everything
-- else in this statement is an index lookup by array (not a nested loop) or a hash join, which are linear. enable_seqscan = off for the
-- same reason (a one-learner call must not scan the class: with no statistics the planner would choose a sequential scan of the
-- marks of the whole college). enable_mergejoin = off and work_mem = 32MB: with nested loops gone the planner chose merge joins whose
-- sorts of 60,000 rows spilled to disk (4 MB default): hash joins in memory are 25 % faster. The settings are scoped to this
-- function; bench:gradebook measures a fresh college and fails on a regression.
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp SET enable_nestloop = off SET enable_seqscan = off
  SET enable_mergejoin = off SET work_mem = '32MB'
AS $$
#variable_conflict use_column
DECLARE
  small boolean := p_participants IS NOT NULL AND cardinality(p_participants) <= 25;
BEGIN
  RETURN QUERY
WITH
gb AS MATERIALIZED (
  SELECT g.* FROM lms.gradebooks g WHERE g.tenant_id = p_tenant AND g.offering_id = p_offering),
cat AS MATERIALIZED (
  SELECT c.* FROM lms.gradebook_categories c, gb WHERE c.tenant_id = p_tenant AND c.gradebook_id = gb.id),
it AS MATERIALIZED (
  SELECT i.id, i.category_id, i.source, i.content_item_id, coalesce(i.title, ci.title) AS title, i.points,
         i.extra_credit, i.position, i.due_at, i.released AS m_released,
         asa.closes_at, asa.scoring, asa.results_visibility,
         ag.due_at AS a_due, ag.late_policy, ag.late_cutoff_at, ag.max_points AS a_max, ag.release_mode,
         ag.penalty_kind, ag.penalty_value, ag.penalty_cap
    FROM lms.gradebook_items i
    JOIN gb ON gb.id = i.gradebook_id
    LEFT JOIN lms.content_items ci ON ci.tenant_id = i.tenant_id AND ci.id = i.content_item_id
    LEFT JOIN lms.assessments asa ON asa.tenant_id = i.tenant_id AND asa.item_id = i.content_item_id
    LEFT JOIN lms.assignments ag ON ag.tenant_id = i.tenant_id AND ag.item_id = i.content_item_id
   WHERE i.tenant_id = p_tenant AND i.archived_at IS NULL AND (i.source = 'manual' OR ci.deleted_at IS NULL)),
parts AS MATERIALIZED (
  -- the whole class, or exactly the learners asked for by primary key (a one-learner call must not read the class)
  SELECT p.id AS pid FROM lms.course_participants p
   WHERE p_participants IS NULL AND p.tenant_id = p_tenant AND p.offering_id = p_offering
     AND p.participation = 'learner' AND p.status = 'active'
  UNION ALL
  SELECT p.id FROM lms.course_participants p
   WHERE p_participants IS NOT NULL AND p.id = ANY (p_participants) AND p.tenant_id = p_tenant
     AND p.offering_id = p_offering AND p.participation = 'learner' AND p.status = 'active'),
-- the learners and the items every source is limited to
lim AS MATERIALIZED (
  SELECT (SELECT array_agg(pid) FROM parts) AS pids,
         coalesce((SELECT array_agg(id) FROM it WHERE source = 'manual'), '{}') AS manual_items,
         coalesce((SELECT array_agg(content_item_id) FROM it WHERE source = 'assessment'), '{}') AS assessment_items,
         coalesce((SELECT array_agg(content_item_id) FROM it WHERE source = 'assignment'), '{}') AS assignment_items),
mm AS MATERIALIZED (
  SELECT m.item_id, m.participant_id, m.points FROM lms.manual_marks m
   WHERE m.tenant_id = p_tenant AND m.item_id = ANY ((SELECT manual_items FROM lim)::uuid[])
     AND m.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
ovr AS MATERIALIZED (
  SELECT o.item_id, o.participant_id, o.points FROM lms.grade_overrides o, gb
   WHERE o.tenant_id = p_tenant AND o.gradebook_id = gb.id AND o.revoked_at IS NULL AND o.participant_id = ANY ((SELECT pids FROM lim)::uuid[])
     AND o.item_id IS NOT NULL),
-- BULK sources (a class, a chunk of a class): the quizzes and assignments of the gradebook read once for all learners asked for.
-- Skipped (one-time filter) when only a few learners are asked for: those take the LATERAL probes below.
asm AS MATERIALIZED (
  SELECT x.item_id, x.participant_id,
         CASE x.scoring WHEN 'highest' THEN (array_agg(x.score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.score), 2) END AS score,
         CASE x.scoring WHEN 'highest' THEN (array_agg(x.max_score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.max_score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.max_score), 2) END AS max_score,
         bool_and(x.visible) AS released
    FROM (SELECT a.assessment_item_id AS item_id, a.participant_id, a.attempt_no, a.score, a.max_score, s.scoring,
                 CASE WHEN a.max_score > 0 THEN round(a.score * 100 / a.max_score, 2) ELSE 0 END AS pct,
                 lms.results_visible(s.results_visibility,
                   CASE WHEN s.closes_at IS NULL THEN NULL
                        ELSE greatest(s.closes_at, coalesce(acc.extended_close_at, s.closes_at)) END,
                   a.released_at) AS visible
            FROM lms.attempts a
            JOIN lms.assessments s ON s.tenant_id = a.tenant_id AND s.item_id = a.assessment_item_id
            LEFT JOIN lms.assessment_accommodations acc ON acc.tenant_id = a.tenant_id
                 AND acc.assessment_item_id = a.assessment_item_id AND acc.participant_id = a.participant_id
           WHERE NOT small AND a.tenant_id = p_tenant AND a.offering_id = p_offering AND a.status = 'graded'
             AND a.assessment_item_id = ANY ((SELECT assessment_items FROM lim)::uuid[])
             AND a.participant_id = ANY ((SELECT pids FROM lim)::uuid[])) x
   GROUP BY x.item_id, x.participant_id, x.scoring),
asg AS MATERIALIZED (
  SELECT gr.assignment_item_id AS item_id, gr.participant_id,
         lms.assignment_final_points(gr.raw_score, a.max_points, pen.pct) AS score, a.max_points AS max_score,
         (gr.released_at IS NOT NULL OR a.release_mode = 'immediate') AS released
    FROM lms.assignment_grades gr
    JOIN lms.assignments a ON a.tenant_id = gr.tenant_id AND a.item_id = gr.assignment_item_id
    JOIN lms.submissions s ON s.tenant_id = gr.tenant_id AND s.id = gr.submission_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN gr.penalty_waived THEN 0::numeric
                  WHEN gr.penalty_percent IS NOT NULL THEN gr.penalty_percent
                  ELSE lms.assignment_penalty_percent(a.penalty_kind, a.penalty_value, a.penalty_cap, s.late_seconds)
             END AS pct) pen
   WHERE NOT small AND gr.tenant_id = p_tenant AND a.offering_id = p_offering
     AND gr.assignment_item_id = ANY ((SELECT assignment_items FROM lim)::uuid[])
     AND gr.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
att AS MATERIALIZED (
  SELECT DISTINCT a.assessment_item_id AS item_id, a.participant_id FROM lms.attempts a
   WHERE NOT small AND a.tenant_id = p_tenant AND a.assessment_item_id = ANY ((SELECT assessment_items FROM lim)::uuid[])
     AND a.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
sub AS MATERIALIZED (
  SELECT DISTINCT s.assignment_item_id AS item_id, s.participant_id FROM lms.submissions s
   WHERE NOT small AND s.tenant_id = p_tenant AND s.assignment_item_id = ANY ((SELECT assignment_items FROM lim)::uuid[])
     AND s.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
acc AS MATERIALIZED (
  SELECT x.assessment_item_id AS item_id, x.participant_id, x.extended_close_at FROM lms.assessment_accommodations x
   WHERE NOT small AND x.tenant_id = p_tenant AND x.assessment_item_id = ANY ((SELECT assessment_items FROM lim)::uuid[])
     AND x.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
ext AS MATERIALIZED (
  SELECT x.assignment_item_id AS item_id, x.participant_id, x.extended_due_at FROM lms.assignment_extensions x
   WHERE NOT small AND x.tenant_id = p_tenant AND x.assignment_item_id = ANY ((SELECT assignment_items FROM lim)::uuid[])
     AND x.participant_id = ANY ((SELECT pids FROM lim)::uuid[])),
-- the cells, one query per source
cell AS (
  SELECT pa.pid, i.id AS item_id, i.category_id, i.source, i.points, i.extra_credit, i.position,
         c.missing_policy, c.drop_lowest,
         m.points AS score, NULL::numeric AS smax, i.m_released AS released,
         (m.participant_id IS NOT NULL) AS has_score, false AS has_work, ov.points AS ov_points,
         ((i.due_at IS NOT NULL AND i.due_at < now()) OR i.m_released) AS overdue
    FROM parts pa CROSS JOIN it i JOIN cat c ON c.id = i.category_id
    LEFT JOIN mm m ON m.item_id = i.id AND m.participant_id = pa.pid
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
   WHERE i.source = 'manual'
  UNION ALL
  SELECT pa.pid, i.id, i.category_id, i.source, i.points, i.extra_credit, i.position, c.missing_policy, c.drop_lowest,
         s1.score, s1.max_score, coalesce(s1.released, false),
         (s1.n_graded > 0), (s1.n_any > 0), ov.points,
         coalesce(i.closes_at IS NOT NULL AND greatest(i.closes_at, coalesce(ac.extended_close_at, i.closes_at)) < now(), false)
    FROM parts pa CROSS JOIN it i JOIN cat c ON c.id = i.category_id
    LEFT JOIN LATERAL (SELECT x.extended_close_at FROM lms.assessment_accommodations x
                        WHERE x.tenant_id = p_tenant AND x.assessment_item_id = i.content_item_id
                          AND x.participant_id = pa.pid) ac ON true
    -- what a quiz gives the gradebook: step 9's final-score aggregation, with `released` by the learner's own rule, for ONE
    -- learner and ONE assessment (unique-key probe: attempts_number_key)
    LEFT JOIN LATERAL (
      SELECT count(*) AS n_any,
             count(*) FILTER (WHERE a.status = 'graded') AS n_graded,
             CASE i.scoring
               WHEN 'highest' THEN (array_agg(a.score ORDER BY a.pct DESC, a.attempt_no DESC) FILTER (WHERE a.status = 'graded'))[1]
               WHEN 'latest' THEN (array_agg(a.score ORDER BY a.attempt_no DESC) FILTER (WHERE a.status = 'graded'))[1]
               ELSE round(avg(a.score) FILTER (WHERE a.status = 'graded'), 2) END AS score,
             CASE i.scoring
               WHEN 'highest' THEN (array_agg(a.max_score ORDER BY a.pct DESC, a.attempt_no DESC) FILTER (WHERE a.status = 'graded'))[1]
               WHEN 'latest' THEN (array_agg(a.max_score ORDER BY a.attempt_no DESC) FILTER (WHERE a.status = 'graded'))[1]
               ELSE round(avg(a.max_score) FILTER (WHERE a.status = 'graded'), 2) END AS max_score,
             bool_and(lms.results_visible(i.results_visibility,
                        CASE WHEN i.closes_at IS NULL THEN NULL
                             ELSE greatest(i.closes_at, coalesce(ac.extended_close_at, i.closes_at)) END,
                        a.released_at)) FILTER (WHERE a.status = 'graded') AS released
        FROM (SELECT t.*, CASE WHEN t.max_score > 0 THEN round(t.score * 100 / t.max_score, 2) ELSE 0 END AS pct
                FROM lms.attempts t
               WHERE t.tenant_id = p_tenant AND t.assessment_item_id = i.content_item_id AND t.participant_id = pa.pid) a) s1 ON true
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
   WHERE i.source = 'assessment' AND small
  UNION ALL
  SELECT pa.pid, i.id, i.category_id, i.source, i.points, i.extra_credit, i.position, c.missing_policy, c.drop_lowest,
         s2.score, s2.max_score, coalesce(s2.released, false),
         (s2.found IS NOT NULL), (a2.found IS NOT NULL), ov.points,
         coalesce(i.a_due IS NOT NULL AND
           CASE WHEN i.late_policy = 'allowed'
                THEN i.late_cutoff_at + greatest(greatest(i.a_due, coalesce(x.extended_due_at, i.a_due)) - i.a_due, interval '0')
                ELSE greatest(i.a_due, coalesce(x.extended_due_at, i.a_due)) END < now(), false)
    FROM parts pa CROSS JOIN it i JOIN cat c ON c.id = i.category_id
    LEFT JOIN LATERAL (
      SELECT true AS found, lms.assignment_final_points(gr.raw_score, i.a_max, pen.pct) AS score, i.a_max AS max_score,
             (gr.released_at IS NOT NULL OR i.release_mode = 'immediate') AS released
        FROM lms.assignment_grades gr
        CROSS JOIN LATERAL (
          SELECT CASE WHEN gr.penalty_waived THEN 0::numeric
                      WHEN gr.penalty_percent IS NOT NULL THEN gr.penalty_percent
                      ELSE lms.assignment_penalty_percent(i.penalty_kind, i.penalty_value, i.penalty_cap,
                             (SELECT sb.late_seconds FROM lms.submissions sb
                               WHERE sb.tenant_id = p_tenant AND sb.id = gr.submission_id))
                 END AS pct) pen
       WHERE gr.tenant_id = p_tenant AND gr.assignment_item_id = i.content_item_id AND gr.participant_id = pa.pid) s2 ON true
    LEFT JOIN LATERAL (SELECT true AS found FROM lms.submissions sb
                        WHERE sb.tenant_id = p_tenant AND sb.assignment_item_id = i.content_item_id
                          AND sb.participant_id = pa.pid LIMIT 1) a2 ON true
    LEFT JOIN LATERAL (SELECT e.extended_due_at FROM lms.assignment_extensions e
                        WHERE e.tenant_id = p_tenant AND e.assignment_item_id = i.content_item_id
                          AND e.participant_id = pa.pid) x ON true
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
   WHERE i.source = 'assignment' AND small
  UNION ALL
  SELECT pa.pid, i.id, i.category_id, i.source, i.points, i.extra_credit, i.position, c.missing_policy, c.drop_lowest,
         s1.score, s1.max_score, coalesce(s1.released, false),
         (s1.participant_id IS NOT NULL), (a1.participant_id IS NOT NULL), ov.points,
         coalesce(i.closes_at IS NOT NULL AND greatest(i.closes_at, coalesce(ac.extended_close_at, i.closes_at)) < now(), false)
    FROM parts pa CROSS JOIN it i JOIN cat c ON c.id = i.category_id
    LEFT JOIN asm s1 ON s1.item_id = i.content_item_id AND s1.participant_id = pa.pid
    LEFT JOIN att a1 ON a1.item_id = i.content_item_id AND a1.participant_id = pa.pid
    LEFT JOIN acc ac ON ac.item_id = i.content_item_id AND ac.participant_id = pa.pid
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
   WHERE i.source = 'assessment' AND NOT small
  UNION ALL
  SELECT pa.pid, i.id, i.category_id, i.source, i.points, i.extra_credit, i.position, c.missing_policy, c.drop_lowest,
         s2.score, s2.max_score, coalesce(s2.released, false),
         (s2.participant_id IS NOT NULL), (a2.participant_id IS NOT NULL), ov.points,
         coalesce(i.a_due IS NOT NULL AND
           CASE WHEN i.late_policy = 'allowed'
                THEN i.late_cutoff_at + greatest(greatest(i.a_due, coalesce(x.extended_due_at, i.a_due)) - i.a_due, interval '0')
                ELSE greatest(i.a_due, coalesce(x.extended_due_at, i.a_due)) END < now(), false)
    FROM parts pa CROSS JOIN it i JOIN cat c ON c.id = i.category_id
    LEFT JOIN asg s2 ON s2.item_id = i.content_item_id AND s2.participant_id = pa.pid
    LEFT JOIN sub a2 ON a2.item_id = i.content_item_id AND a2.participant_id = pa.pid
    LEFT JOIN ext x ON x.item_id = i.content_item_id AND x.participant_id = pa.pid
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
   WHERE i.source = 'assignment' AND NOT small),
en AS MATERIALIZED (
  SELECT y.*, (y.state IN ('s', 'o', 'z')) AS counted,
         CASE y.state WHEN 's' THEN CASE WHEN y.source = 'manual' THEN y.score
                                         WHEN coalesce(y.smax, 0) > 0 THEN y.score * y.points ELSE 0::numeric END
                      WHEN 'o' THEN y.ov_points WHEN 'z' THEN 0::numeric END AS e_n,
         CASE y.state WHEN 's' THEN CASE WHEN y.source = 'manual' THEN 1::numeric
                                         WHEN coalesce(y.smax, 0) > 0 THEN y.smax ELSE 1::numeric END
                      WHEN 'o' THEN 1::numeric WHEN 'z' THEN 1::numeric END AS e_d
    FROM (SELECT c.*,
                 CASE WHEN p_mode = 'learner' AND NOT c.released AND (c.source = 'manual' OR c.has_score OR c.ov_points IS NOT NULL) THEN 'h'
                      WHEN c.ov_points IS NOT NULL THEN 'o'
                      WHEN c.has_score THEN 's'
                      WHEN c.source <> 'manual' AND c.has_work THEN 'p'
                      WHEN c.missing_policy = 'zero_after_due' AND c.overdue THEN 'z'
                      ELSE 'x' END AS state
            FROM cell c) y),
rk AS MATERIALIZED (
  -- only the rows of categories that drop anything; the order is made inside each (learner, category) group: a handful of rows
  SELECT e.pid, e.category_id,
         (array_agg(e.item_id ORDER BY lms.frac_key(e.e_n, e.e_d * e.points), e.points, e.position, e.item_id))
           [1:least(max(e.drop_lowest), count(*)::integer - 1)] AS dropped_ids
    FROM en e
   WHERE e.counted AND NOT e.extra_credit AND e.drop_lowest > 0
   GROUP BY e.pid, e.category_id),
dr AS MATERIALIZED (
  SELECT e.*, coalesce(e.item_id = ANY (r.dropped_ids), false) AS dropped
    FROM en e LEFT JOIN rk r ON r.pid = e.pid AND r.category_id = e.category_id),
-- exact sums: native sum() per denominator, the fraction aggregate only over those few groups
ag1 AS (
  SELECT d.pid, d.category_id, d.e_d, sum(d.e_n) AS n,
         sum(d.points) FILTER (WHERE NOT d.extra_credit) AS m
    FROM dr d WHERE d.counted AND NOT d.dropped GROUP BY d.pid, d.category_id, d.e_d),
agg AS (
  SELECT g.pid, g.category_id, lms.frac_sum(g.n, g.e_d) AS e, sum(g.m) AS m
    FROM ag1 g GROUP BY g.pid, g.category_id),
ct AS MATERIALIZED (
  SELECT pa.pid, c.id AS category_id, c.name, c.weight, c.drop_lowest, c.missing_policy, c.position, a.e, a.m,
         (a.m IS NOT NULL AND a.m > 0) AS contrib
    FROM parts pa CROSS JOIN cat c LEFT JOIN agg a ON a.pid = pa.pid AND a.category_id = c.id),
tot AS MATERIALIZED (
  SELECT t.pid,
         lms.frac_sum((t.e).n * t.weight, (t.e).d * t.m) FILTER (WHERE t.contrib AND t.weight > 0) AS f,
         sum(t.weight) FILTER (WHERE t.contrib AND t.weight > 0) AS wsum,
         lms.frac_sum((t.e).n, (t.e).d) FILTER (WHERE t.e IS NOT NULL) AS pe,
         sum(t.m) FILTER (WHERE t.contrib) AS pm
    FROM ct t GROUP BY t.pid),
fr AS MATERIALIZED (
  SELECT t.pid,
         CASE WHEN gb.weighted THEN CASE WHEN t.wsum > 0 THEN gb.out_of * (t.f).n END
              ELSE CASE WHEN t.pm > 0 THEN gb.out_of * (t.pe).n END END AS n,
         CASE WHEN gb.weighted THEN CASE WHEN t.wsum > 0 THEN (t.f).d * t.wsum END
              ELSE CASE WHEN t.pm > 0 THEN (t.pe).d * t.pm END END AS d,
         gb.round_mode, gb.round_decimals, gb.out_of, gb.scale_id, gb.weighted
    FROM tot t CROSS JOIN gb),
fo AS MATERIALIZED (
  SELECT o.participant_id AS pid, o.points FROM lms.grade_overrides o, gb
   WHERE p_mode = 'staff' AND o.tenant_id = p_tenant AND o.gradebook_id = gb.id AND o.item_id IS NULL AND o.revoked_at IS NULL),
fin AS MATERIALIZED (
  SELECT f.pid, f.n, f.d, f.out_of, f.weighted, f.round_mode, f.round_decimals, f.rounded,
         f.ov_points, f.marks, g.label, g.is_pass
    FROM (SELECT x.pid, x.n, x.d, x.out_of, x.weighted, x.round_mode, x.round_decimals, x.scale_id, x.rounded,
                 o.points AS ov_points, coalesce(o.points, x.rounded) AS marks
            FROM (SELECT r.*, lms.round_frac(r.n, r.d, r.round_mode, r.round_decimals) AS rounded FROM fr r) x
            LEFT JOIN fo o ON o.pid = x.pid) f
    LEFT JOIN LATERAL (
      SELECT b.label, b.is_pass FROM lms.grade_scale_bands b
       WHERE b.tenant_id = p_tenant AND b.scale_id = f.scale_id AND f.marks * 100 >= b.min_percent * f.out_of
       ORDER BY b.min_percent DESC LIMIT 1) g ON true),
cj AS (
  SELECT d.pid,
         json_object_agg(d.item_id, json_build_array(
           d.state,
           CASE d.state WHEN 's' THEN CASE WHEN d.source = 'manual' THEN trim_scale(d.score)::text
                                           ELSE trim_scale(round(d.e_n / d.e_d, 2))::text END
                        WHEN 'o' THEN trim_scale(d.ov_points)::text WHEN 'z' THEN '0' END,
           CASE WHEN d.dropped THEN 1 ELSE 0 END)) AS cells
    FROM dr d GROUP BY d.pid),
tj AS (
  SELECT t.pid,
         json_object_agg(t.category_id, json_build_object(
           'e', CASE WHEN t.e IS NOT NULL THEN round((t.e).n / (t.e).d, 4) END,
           'm', t.m,
           'p', CASE WHEN t.contrib THEN round(100 * (t.e).n / ((t.e).d * t.m), 2) END)) AS cats
    FROM ct t GROUP BY t.pid),
ix AS (
  SELECT d.pid, d.category_id,
         json_agg(json_build_object(
           'id', d.item_id, 'title', it2.title, 'state', d.state, 'points', d.points, 'extra', d.extra_credit,
           'dropped', d.dropped,
           'earned', CASE WHEN d.counted THEN round(d.e_n / d.e_d, 4) END,
           'percent', CASE WHEN d.counted THEN round(100 * d.e_n / (d.e_d * d.points), 2) END)
           ORDER BY d.position, d.item_id) AS items
    FROM dr d JOIN it it2 ON it2.id = d.item_id WHERE p_explain AND d.state <> 'h' GROUP BY d.pid, d.category_id),
cx AS (
  SELECT t.pid,
         json_agg(json_build_object(
           'id', t.category_id, 'name', t.name, 'weight', t.weight, 'dropLowest', t.drop_lowest,
           'missingPolicy', t.missing_policy, 'counts', t.contrib,
           'earned', CASE WHEN t.e IS NOT NULL THEN round((t.e).n / (t.e).d, 4) END, 'max', t.m,
           'percent', CASE WHEN t.contrib THEN round(100 * (t.e).n / ((t.e).d * t.m), 4) END,
           'items', coalesce(i.items, '[]'::json)) ORDER BY t.position, t.category_id) AS categories
    FROM ct t LEFT JOIN ix i ON i.pid = t.pid AND i.category_id = t.category_id
   WHERE p_explain GROUP BY t.pid)
SELECT pa.pid,
       coalesce(cj.cells, '{}'::json), coalesce(tj.cats, '{}'::json),
       fi.marks,
       CASE WHEN fi.marks IS NOT NULL THEN round(fi.marks * 100 / fi.out_of, 4) END,
       fi.label, fi.is_pass, fi.ov_points IS NOT NULL,
       CASE WHEN p_explain THEN json_build_object(
         'weighted', fi.weighted, 'outOf', fi.out_of,
         'rounding', json_build_object('mode', fi.round_mode, 'decimals', fi.round_decimals),
         'categories', coalesce(cx.categories, '[]'::json),
         'weightTotal', (SELECT t.wsum FROM tot t WHERE t.pid = pa.pid),
         'unrounded', CASE WHEN fi.d IS NOT NULL THEN round(fi.n / fi.d, 6) END,
         'rounded', fi.rounded,
         'final', fi.marks, 'percent', CASE WHEN fi.marks IS NOT NULL THEN round(fi.marks * 100 / fi.out_of, 4) END,
         'grade', fi.label, 'isPass', fi.is_pass, 'overridden', fi.ov_points IS NOT NULL) END
  FROM parts pa
  LEFT JOIN cj ON cj.pid = pa.pid
  LEFT JOIN tj ON tj.pid = pa.pid
  LEFT JOIN cx ON cx.pid = pa.pid
  LEFT JOIN fin fi ON fi.pid = pa.pid;
END
$$;

-- ------------------------------------------------------------------ the grid, the explanation
CREATE FUNCTION lms.gradebook_grid(p_tenant uuid, p_offering uuid, p_section uuid, p_after_sk text, p_after_id uuid,
                                   p_limit integer)
RETURNS json
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp SET enable_nestloop = off
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
    JOIN lms.users u ON u.id = tm.user_id
    LEFT JOIN lms.member_profiles mp ON mp.tenant_id = p.tenant_id AND mp.membership_id = tm.id
    LEFT JOIN lms.sections sec ON sec.tenant_id = mp.tenant_id AND sec.id = mp.section_id;
  RETURN json_build_object('rows', rows_json, 'next', CASE WHEN more THEN last_key END, 'total', total);
END
$$;

-- ------------------------------------------------------------------ manual marks
-- p_cells: [{itemId, participantId, points|null, expected?}]. A cell with `expected` is applied only if the stored value is
-- still that value (otherwise it is reported as a conflict with the current value). `points` null clears the cell.
-- p_all_items: false for an assistant (only items that allow assistants). Returns the recomputed rows of the learners touched.
CREATE OR REPLACE FUNCTION lms.gradebook_marks_save(p_tenant uuid, p_user uuid, p_offering uuid, p_all_items boolean, p_source text,
                                         p_cells jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp SET enable_nestloop = off
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

-- The approver may not be the submitter unless the college allows it. The refusal is audited (and committed: it is a
-- normal return, not an error).
CREATE OR REPLACE FUNCTION lms.gradebook_review_action(p_tenant uuid, p_user uuid, p_offering uuid, p_action text, p_comment text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = lms, pg_temp SET enable_nestloop = off
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

-- everything the approver needs to decide: the structure, the problems, who is not in the snapshot, the outcome in numbers
CREATE OR REPLACE FUNCTION lms.gradebook_review(p_tenant uuid, p_offering uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = lms, pg_temp SET enable_nestloop = off
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

-- ------------------------------------------------------------------ the learner (definer, autocommit, 2 round trips)
-- Locked and approved: the learner sees the frozen record. Otherwise: the provisional figures from RELEASED items only.
CREATE OR REPLACE FUNCTION lms.gradebook_me(p_tenant uuid, p_user uuid, p_offering uuid)
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
    'explanation', (r.explanation::jsonb - 'grade' - 'isPass'));
END
$$;

-- grants of the two functions that were dropped (CREATE OR REPLACE keeps the others)
REVOKE ALL ON FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean) TO lms_app;
REVOKE ALL ON FUNCTION lms.gradebook_grid(uuid, uuid, uuid, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.gradebook_grid(uuid, uuid, uuid, text, uuid, integer) TO lms_app;

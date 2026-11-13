-- Step 11: the gradebook calculation. ONE set-based function (`lms.gradebook_compute`) is the only place a number is
-- made: the grid, the learner view, the explanation and the lock snapshot all call it, so they can never disagree.
--
-- EXACT ARITHMETIC. Division is the only inexact operation of `numeric` (1/3 + 1/3 + 1/3 = 0.9999...), and a rounding tie
-- ("0.5 marks") must be decided on the true value. So earned points are carried as FRACTIONS (numerator, denominator):
-- `lms.frac_sum` adds fractions with multiplication only, nothing is divided before the end, and the single rounding uses
-- integer division (`lms.round_frac`: `div` and `mod` of numerics are exact). Display values (percent of a category, the
-- earned points of a cell) ARE divisions, rounded for the eye only; they never feed a later step.
--
-- Drop-lowest orders items by their percent. The order key is `div(earned * 10^20, max)`: an exact integer, equal fractions
-- give equal keys (6/3 and 2/1), different ones differ (denominators are far below 10^8, so two different fractions are
-- more than 10^-16 apart).

CREATE TYPE lms.frac AS (n numeric, d numeric);

CREATE FUNCTION lms.frac_add(s lms.frac, n numeric, d numeric)
RETURNS lms.frac
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = lms, pg_temp
AS $$
  SELECT CASE WHEN s.d IS NULL THEN ROW(n, d)::lms.frac
              WHEN s.d = d THEN ROW(s.n + n, d)::lms.frac
              ELSE ROW(s.n * d + n * s.d, s.d * d)::lms.frac END
$$;

CREATE AGGREGATE lms.frac_sum(numeric, numeric) (SFUNC = lms.frac_add, STYPE = lms.frac);

-- n / d (both >= 0, d > 0) rounded to p_decimals places with the rule of the gradebook; exact.
CREATE FUNCTION lms.round_frac(p_n numeric, p_d numeric, p_mode text, p_decimals integer)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = lms, pg_temp
AS $$
  SELECT CASE WHEN p_n IS NULL OR p_d IS NULL OR p_d <= 0 THEN NULL
    ELSE (
      SELECT round((q + CASE p_mode
                    WHEN 'floor' THEN 0
                    WHEN 'ceil' THEN (r > 0)::integer
                    WHEN 'half_even' THEN CASE WHEN 2 * r > p_d THEN 1 WHEN 2 * r = p_d THEN mod(q, 2)::integer ELSE 0 END
                    ELSE (2 * r >= p_d)::integer END) / power(10::numeric, p_decimals), p_decimals)
        FROM (SELECT div(p_n * power(10::numeric, p_decimals), p_d) AS q,
                     mod(p_n * power(10::numeric, p_decimals), p_d) AS r) x)
    END
$$;

-- Stable across versions of the same fraction (used for the order key of drop-lowest)
CREATE FUNCTION lms.frac_key(p_n numeric, p_d numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = lms, pg_temp
AS $$ SELECT div(p_n * 100000000000000000000::numeric, p_d) $$;

-- ------------------------------------------------------------------ the score an assessment gives the gradebook
-- The same aggregation as `assessment_final_scores` (step 9), but `released` follows the rule the LEARNER's own page uses
-- (`results_visible`: immediate / after the close date / manual release), per attempt, and an item counts as released only
-- when EVERY graded attempt it is based on is visible (the average or the best of attempts must not reveal a hidden one).
-- `assessment_final_scores` reports only the manual release, so a quiz with immediate results would look unreleased forever.
CREATE FUNCTION lms.gradebook_assessment_scores(p_tenant uuid, p_offering uuid)
RETURNS TABLE (item_id uuid, participant_id uuid, score numeric, max_score numeric, released boolean)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT x.item_id, x.participant_id,
         CASE x.scoring WHEN 'highest' THEN (array_agg(x.score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.score), 2) END,
         CASE x.scoring WHEN 'highest' THEN (array_agg(x.max_score ORDER BY x.pct DESC, x.attempt_no DESC))[1]
                        WHEN 'latest' THEN (array_agg(x.max_score ORDER BY x.attempt_no DESC))[1]
                        ELSE round(avg(x.max_score), 2) END,
         bool_and(x.visible)
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
           WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering AND a.status = 'graded') x
   GROUP BY x.item_id, x.participant_id, x.scoring
$$;
REVOKE ALL ON FUNCTION lms.gradebook_assessment_scores(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.gradebook_assessment_scores(uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ the calculation
-- p_mode 'staff': every score counts, overrides apply. 'learner': only RELEASED items count (an unreleased item behaves as
-- if it did not exist: no state, no mention), final overrides are ignored. p_participants NULL = every active learner.
-- States of a cell: s scored, o overridden, z counted as zero (missing, policy), x missing and left out, p work handed in
-- but not graded yet (left out), h hidden from the learner (left out).
-- Items of an archived or deleted content item are not part of the gradebook.
CREATE FUNCTION lms.gradebook_compute(
  p_tenant uuid, p_offering uuid, p_mode text, p_participants uuid[], p_explain boolean)
RETURNS TABLE (participant_id uuid, cells jsonb, cats jsonb, final_marks numeric, final_percent numeric,
               grade text, is_pass boolean, overridden boolean, explanation jsonb)
-- enable_nestloop = off: called with parameters the planner does not know (and, in a freshly loaded college, with no statistics
-- at all) it picks nested loops over the 30,000-cell join and takes minutes (measured: 47 s instead of 1 s). Hash joins are linear.
LANGUAGE sql STABLE SET search_path = lms, pg_temp SET enable_nestloop = off
AS $$
WITH
gb AS MATERIALIZED (
  SELECT g.* FROM lms.gradebooks g WHERE g.tenant_id = p_tenant AND g.offering_id = p_offering),
cat AS MATERIALIZED (
  SELECT c.* FROM lms.gradebook_categories c, gb WHERE c.tenant_id = p_tenant AND c.gradebook_id = gb.id),
it AS MATERIALIZED (
  SELECT i.id, i.category_id, i.source, i.content_item_id, coalesce(i.title, ci.title) AS title, i.points,
         i.extra_credit, i.position, i.due_at, i.released AS m_released
    FROM lms.gradebook_items i
    JOIN gb ON gb.id = i.gradebook_id
    LEFT JOIN lms.content_items ci ON ci.tenant_id = i.tenant_id AND ci.id = i.content_item_id
   WHERE i.tenant_id = p_tenant AND i.archived_at IS NULL AND (i.source = 'manual' OR ci.deleted_at IS NULL)),
parts AS MATERIALIZED (
  SELECT p.id AS pid FROM lms.course_participants p
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND p.participation = 'learner' AND p.status = 'active'
     AND (p_participants IS NULL OR p.id = ANY (p_participants))),
asm AS MATERIALIZED (
  SELECT f.item_id, f.participant_id, f.score, f.max_score, f.released
    FROM lms.gradebook_assessment_scores(p_tenant, p_offering) f
   WHERE EXISTS (SELECT 1 FROM it WHERE it.source = 'assessment')),
asg AS MATERIALIZED (
  SELECT f.item_id, f.participant_id, f.score, f.max_score, f.released
    FROM lms.assignment_final_scores(p_tenant, p_offering) f
   WHERE EXISTS (SELECT 1 FROM it WHERE it.source = 'assignment')),
att AS MATERIALIZED (
  SELECT DISTINCT a.assessment_item_id AS item_id, a.participant_id FROM lms.attempts a
   WHERE a.tenant_id = p_tenant AND a.offering_id = p_offering),
sub AS MATERIALIZED (
  SELECT DISTINCT s.assignment_item_id AS item_id, s.participant_id FROM lms.submissions s
   WHERE s.tenant_id = p_tenant AND s.offering_id = p_offering),
ovr AS MATERIALIZED (
  SELECT o.item_id, o.participant_id, o.points FROM lms.grade_overrides o, gb
   WHERE o.tenant_id = p_tenant AND o.gradebook_id = gb.id AND o.revoked_at IS NULL),
mm AS MATERIALIZED (
  SELECT m.item_id, m.participant_id, m.points FROM lms.manual_marks m
   WHERE m.tenant_id = p_tenant AND m.item_id IN (SELECT id FROM it WHERE source = 'manual')),
cell AS MATERIALIZED (
  SELECT pa.pid, i.id AS item_id, i.category_id, i.source, i.title, i.points, i.extra_credit, i.position,
         c.missing_policy, c.drop_lowest,
         coalesce(s1.score, s2.score, m.points) AS score,
         coalesce(s1.max_score, s2.max_score) AS smax,
         CASE WHEN i.source = 'manual' THEN i.m_released ELSE coalesce(s1.released, s2.released, false) END AS released,
         (s1.participant_id IS NOT NULL OR s2.participant_id IS NOT NULL OR m.participant_id IS NOT NULL) AS has_score,
         (a1.participant_id IS NOT NULL OR a2.participant_id IS NOT NULL) AS has_work,
         ov.points AS ov_points,
         CASE i.source
           WHEN 'assessment' THEN coalesce(asa.closes_at IS NOT NULL
             AND greatest(asa.closes_at, coalesce(acc.extended_close_at, asa.closes_at)) < now(), false)
           WHEN 'assignment' THEN coalesce(ag.due_at IS NOT NULL AND
             CASE WHEN ag.late_policy = 'allowed'
                  THEN ag.late_cutoff_at + greatest(greatest(ag.due_at, coalesce(ext.extended_due_at, ag.due_at)) - ag.due_at, interval '0')
                  ELSE greatest(ag.due_at, coalesce(ext.extended_due_at, ag.due_at)) END < now(), false)
           ELSE (i.due_at IS NOT NULL AND i.due_at < now()) OR i.m_released
         END AS overdue
    FROM parts pa
    CROSS JOIN it i
    JOIN cat c ON c.id = i.category_id
    LEFT JOIN asm s1 ON s1.item_id = i.content_item_id AND s1.participant_id = pa.pid
    LEFT JOIN asg s2 ON s2.item_id = i.content_item_id AND s2.participant_id = pa.pid
    LEFT JOIN mm m ON m.item_id = i.id AND m.participant_id = pa.pid
    LEFT JOIN att a1 ON a1.item_id = i.content_item_id AND a1.participant_id = pa.pid
    LEFT JOIN sub a2 ON a2.item_id = i.content_item_id AND a2.participant_id = pa.pid
    LEFT JOIN ovr ov ON ov.item_id = i.id AND ov.participant_id = pa.pid
    LEFT JOIN lms.assessments asa ON asa.tenant_id = p_tenant AND asa.item_id = i.content_item_id
    LEFT JOIN lms.assessment_accommodations acc ON acc.tenant_id = p_tenant
         AND acc.assessment_item_id = i.content_item_id AND acc.participant_id = pa.pid
    LEFT JOIN lms.assignments ag ON ag.tenant_id = p_tenant AND ag.item_id = i.content_item_id
    LEFT JOIN lms.assignment_extensions ext ON ext.tenant_id = p_tenant
         AND ext.assignment_item_id = i.content_item_id AND ext.participant_id = pa.pid),
st AS MATERIALIZED (
  SELECT c.*,
         CASE WHEN p_mode = 'learner' AND NOT c.released AND (c.source = 'manual' OR c.has_score OR c.ov_points IS NOT NULL) THEN 'h'
              WHEN c.ov_points IS NOT NULL THEN 'o'
              WHEN c.has_score THEN 's'
              WHEN c.source <> 'manual' AND c.has_work THEN 'p'
              WHEN c.missing_policy = 'zero_after_due' AND c.overdue THEN 'z'
              ELSE 'x' END AS state
    FROM cell c),
en AS MATERIALIZED (
  SELECT s.*,
         CASE s.state WHEN 's' THEN CASE WHEN s.source = 'manual' THEN s.score
                                         WHEN coalesce(s.smax, 0) > 0 THEN s.score * s.points ELSE 0::numeric END
                      WHEN 'o' THEN s.ov_points WHEN 'z' THEN 0::numeric END AS e_n,
         CASE s.state WHEN 's' THEN CASE WHEN s.source = 'manual' THEN 1::numeric
                                         WHEN coalesce(s.smax, 0) > 0 THEN s.smax ELSE 1::numeric END
                      WHEN 'o' THEN 1::numeric WHEN 'z' THEN 1::numeric END AS e_d,
         s.state IN ('s', 'o', 'z') AS counted
    FROM st s),
rk AS MATERIALIZED (
  -- only the rows of categories that drop anything take part in the (sorting) window
  SELECT e.pid, e.item_id,
         row_number() OVER (PARTITION BY e.pid, e.category_id
                            ORDER BY lms.frac_key(e.e_n, e.e_d * e.points), e.points, e.position, e.item_id) AS rn,
         count(*) OVER (PARTITION BY e.pid, e.category_id) AS cnt
    FROM en e
   WHERE e.counted AND NOT e.extra_credit AND e.drop_lowest > 0),
dr AS MATERIALIZED (
  SELECT e.*, (r.rn IS NOT NULL AND r.rn <= least(e.drop_lowest, r.cnt - 1)) AS dropped
    FROM en e LEFT JOIN rk r ON r.pid = e.pid AND r.item_id = e.item_id),
agg AS MATERIALIZED (
  SELECT d.pid, d.category_id,
         -- manual marks all have the denominator 1: they are added natively, only the scaled scores use the fraction aggregate
         CASE WHEN count(*) FILTER (WHERE d.counted AND NOT d.dropped) = 0 THEN NULL
              ELSE lms.frac_add(lms.frac_sum(d.e_n, d.e_d) FILTER (WHERE d.counted AND NOT d.dropped AND d.e_d <> 1),
                                coalesce(sum(d.e_n) FILTER (WHERE d.counted AND NOT d.dropped AND d.e_d = 1), 0), 1) END AS e,
         sum(d.points) FILTER (WHERE d.counted AND NOT d.dropped AND NOT d.extra_credit) AS m
    FROM dr d GROUP BY d.pid, d.category_id),
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
  SELECT f.pid, f.n, f.d, f.out_of, f.weighted, f.round_mode, f.round_decimals,
         lms.round_frac(f.n, f.d, f.round_mode, f.round_decimals) AS rounded,
         o.points AS ov_points,
         coalesce(o.points, lms.round_frac(f.n, f.d, f.round_mode, f.round_decimals)) AS marks,
         g.label, g.is_pass
    FROM fr f
    LEFT JOIN fo o ON o.pid = f.pid
    LEFT JOIN LATERAL (
      SELECT b.label, b.is_pass FROM lms.grade_scale_bands b
       WHERE b.tenant_id = p_tenant AND b.scale_id = f.scale_id
         AND coalesce(o.points, lms.round_frac(f.n, f.d, f.round_mode, f.round_decimals)) * 100 >= b.min_percent * f.out_of
       ORDER BY b.min_percent DESC LIMIT 1) g ON true),
cj AS (
  SELECT d.pid,
         jsonb_object_agg(d.item_id, jsonb_build_array(
           d.state,
           CASE d.state WHEN 's' THEN CASE WHEN d.source = 'manual' THEN trim_scale(d.score)::text
                                           ELSE trim_scale(round(d.e_n / d.e_d, 2))::text END
                        WHEN 'o' THEN trim_scale(d.ov_points)::text WHEN 'z' THEN '0' END,
           CASE WHEN d.dropped THEN 1 ELSE 0 END)) AS cells
    FROM dr d GROUP BY d.pid),
tj AS (
  SELECT t.pid,
         jsonb_object_agg(t.category_id, jsonb_build_object(
           'e', CASE WHEN t.e IS NOT NULL THEN round((t.e).n / (t.e).d, 4) END,
           'm', t.m,
           'p', CASE WHEN t.contrib THEN round(100 * (t.e).n / ((t.e).d * t.m), 2) END)) AS cats
    FROM ct t GROUP BY t.pid),
ix AS (
  SELECT d.pid, d.category_id,
         jsonb_agg(jsonb_build_object(
           'id', d.item_id, 'title', d.title, 'state', d.state, 'points', d.points, 'extra', d.extra_credit,
           'dropped', d.dropped,
           'earned', CASE WHEN d.counted THEN round(d.e_n / d.e_d, 4) END,
           'percent', CASE WHEN d.counted THEN round(100 * d.e_n / (d.e_d * d.points), 2) END)
           ORDER BY d.position, d.item_id) AS items
    FROM dr d WHERE p_explain AND d.state <> 'h' GROUP BY d.pid, d.category_id),
cx AS (
  SELECT t.pid,
         jsonb_agg(jsonb_build_object(
           'id', t.category_id, 'name', t.name, 'weight', t.weight, 'dropLowest', t.drop_lowest,
           'missingPolicy', t.missing_policy, 'counts', t.contrib,
           'earned', CASE WHEN t.e IS NOT NULL THEN round((t.e).n / (t.e).d, 4) END, 'max', t.m,
           'percent', CASE WHEN t.contrib THEN round(100 * (t.e).n / ((t.e).d * t.m), 4) END,
           'items', coalesce(i.items, '[]'::jsonb)) ORDER BY t.position, t.category_id) AS categories
    FROM ct t LEFT JOIN ix i ON i.pid = t.pid AND i.category_id = t.category_id
   WHERE p_explain GROUP BY t.pid)
SELECT pa.pid,
       coalesce(cj.cells, '{}'::jsonb), coalesce(tj.cats, '{}'::jsonb),
       fi.marks,
       CASE WHEN fi.marks IS NOT NULL THEN round(fi.marks * 100 / fi.out_of, 4) END,
       fi.label, fi.is_pass, fi.ov_points IS NOT NULL,
       CASE WHEN p_explain THEN jsonb_build_object(
         'weighted', fi.weighted, 'outOf', fi.out_of,
         'rounding', jsonb_build_object('mode', fi.round_mode, 'decimals', fi.round_decimals),
         'categories', coalesce(cx.categories, '[]'::jsonb),
         'weightTotal', (SELECT t.wsum FROM tot t WHERE t.pid = pa.pid),
         'unrounded', CASE WHEN fi.d IS NOT NULL THEN round(fi.n / fi.d, 6) END,
         'rounded', fi.rounded,
         'final', fi.marks, 'percent', CASE WHEN fi.marks IS NOT NULL THEN round(fi.marks * 100 / fi.out_of, 4) END,
         'grade', fi.label, 'isPass', fi.is_pass, 'overridden', fi.ov_points IS NOT NULL) END
  FROM parts pa
  LEFT JOIN cj ON cj.pid = pa.pid
  LEFT JOIN tj ON tj.pid = pa.pid
  LEFT JOIN cx ON cx.pid = pa.pid
  LEFT JOIN fin fi ON fi.pid = pa.pid
$$;
REVOKE ALL ON FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean) TO lms_app;
REVOKE ALL ON FUNCTION lms.round_frac(numeric, numeric, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.frac_key(numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.frac_add(lms.frac, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.frac_sum(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.round_frac(numeric, numeric, text, integer) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.frac_key(numeric, numeric) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.frac_add(lms.frac, numeric, numeric) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.frac_sum(numeric, numeric) TO lms_app;

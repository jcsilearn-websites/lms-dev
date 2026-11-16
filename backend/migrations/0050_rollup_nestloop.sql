-- Step 12: measured ON and OFF on the 10,000-student college (no statistics): the per-offering functions probe unique keys (a
-- submission by item + learner, an attempt by item + learner), which nested loops do best: learners_apply 101 -> 43 ms for a
-- 250-learner offering (and 91 -> 31 ms for 3 learners), offering_day 19 -> 14 ms. The pin of migration 0048 stays only where it was
-- neutral (the two day-window functions: one aggregation each, no nested loop available to choose wrongly).
ALTER FUNCTION lms.rollup_learners_apply(uuid, uuid, uuid[], timestamptz) RESET enable_nestloop;
ALTER FUNCTION lms.rollup_offering_day_apply(uuid, uuid) RESET enable_nestloop;

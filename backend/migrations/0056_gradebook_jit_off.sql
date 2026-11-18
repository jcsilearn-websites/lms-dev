-- JIT off for the gradebook functions that override planner settings (found by the FIRST CI run on Linux).
--
-- These functions run with enable_nestloop = off (gradebook_compute also enable_seqscan = off). In PostgreSQL a disabled plan node
-- is charged disable_cost (1e10), so the statements inside look astronomically expensive to the planner, far above jit_above_cost
-- (100,000) and jit_optimize_above_cost (500,000), however small the data is. A server built with LLVM JIT (the official postgres:17
-- image, Cloud SQL) then compiles every inner statement on every call: the gradebook tests, tens of milliseconds on a developer
-- machine without JIT, took 3-10+ s on CI and ~20 of them hit the 10 s timeout. The analytics functions had the same problem and the
-- same cure (migration 0049). A college without statistics makes ordinary plans look expensive too, so this is not a CI-only issue.
--
-- ALTER FUNCTION ... SET adds to the function's existing settings (search_path, enable_*, work_mem stay) and does not touch the body.
-- Callers that only wrap these functions (gradebook_me, the approval and import functions) run cheap statements of their own and
-- reach the calculation through gradebook_compute, which now carries the setting itself.
ALTER FUNCTION lms.gradebook_compute(uuid, uuid, text, uuid[], boolean) SET jit = off;
ALTER FUNCTION lms.gradebook_grid(uuid, uuid, uuid, text, uuid, integer) SET jit = off;
ALTER FUNCTION lms.gradebook_marks_save(uuid, uuid, uuid, boolean, text, jsonb) SET jit = off;
ALTER FUNCTION lms.gradebook_review(uuid, uuid) SET jit = off;
ALTER FUNCTION lms.gradebook_review_action(uuid, uuid, uuid, text, text) SET jit = off;

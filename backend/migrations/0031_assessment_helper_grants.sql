-- Step 9d: two helper functions of migration 0029 were left executable by PUBLIC (they are harmless, STABLE and run with
-- the caller's rights, but every function in schema lms follows the same rule: EXECUTE revoked from PUBLIC). The definer
-- functions that use them run as the owner and need no grant; lms_app gets it for the plain SQL of the application.
REVOKE ALL ON FUNCTION lms.assessment_effective_close(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.results_visible(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assessment_effective_close(uuid, uuid) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.results_visible(text, timestamptz, timestamptz) TO lms_app;

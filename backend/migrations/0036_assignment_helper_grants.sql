-- Step 10d: the pure helpers of the assignment statements follow the rule of every function in schema lms: EXECUTE is
-- revoked from PUBLIC and given to lms_app only (the grading statements call them with the caller's rights; they read
-- through row-level security like any query of the application).
REVOKE ALL ON FUNCTION lms.assignment_penalty_percent(text, numeric, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.assignment_timing(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.assignment_final_points(numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.anon_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.assignment_penalty_percent(text, numeric, numeric, integer) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.assignment_timing(uuid, uuid, uuid) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.assignment_final_points(numeric, numeric, numeric) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.anon_code() TO lms_app;

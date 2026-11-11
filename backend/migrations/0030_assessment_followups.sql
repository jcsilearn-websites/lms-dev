-- Step 9c: two things the first two migrations of step 9 left out.

-- the builder saves the questions of an assessment as an upsert by position (one statement, no delete-then-insert clash)
GRANT UPDATE (kind, question_id, tag, difficulty, count, points) ON lms.assessment_slots TO lms_app;

-- a CSV import that was uploaded but never confirmed or cancelled is thrown away after a day (its staged rows cascade).
-- The worker has no tenant context, so this is a definer function; lms_app has no DELETE on question_imports.
CREATE FUNCTION lms.question_imports_purge(p_age interval)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM lms.question_imports i
     WHERE i.status = 'staged' AND i.created_at < now() - p_age
    RETURNING 1)
  SELECT count(*)::integer FROM gone
$$;
REVOKE ALL ON FUNCTION lms.question_imports_purge(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.question_imports_purge(interval) TO lms_app;

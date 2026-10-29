-- Step 5 fix (forward-only; 0013 stays as it is): an abandoned draft (validated, never confirmed) is
-- cancelled by the retention purge, and it was stamped "finished now", so its staged rows (names, emails)
-- would have lived another full retention period. It is stamped with its last activity instead, so the same
-- pass purges its rows.
CREATE OR REPLACE FUNCTION lms.import_purge_rows(p_retention_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.import_jobs j SET status = 'cancelled', finished_at = j.updated_at, updated_at = now()
   WHERE j.status = 'validated' AND j.rows_purged_at IS NULL
     AND j.updated_at < now() - make_interval(days => p_retention_days);

  WITH victims AS (
    SELECT j.tenant_id, j.id FROM lms.import_jobs j
     WHERE j.rows_purged_at IS NULL
       AND j.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
       AND COALESCE(j.finished_at, j.updated_at) < now() - make_interval(days => p_retention_days)
     LIMIT 100
  ), doomed AS (
    SELECT r.tenant_id, r.import_id, r.row_number FROM lms.import_rows r
      JOIN victims v ON v.tenant_id = r.tenant_id AND v.id = r.import_id
     LIMIT LEAST(GREATEST(p_batch, 1), 10000)
  )
  DELETE FROM lms.import_rows r USING doomed d
   WHERE r.tenant_id = d.tenant_id AND r.import_id = d.import_id AND r.row_number = d.row_number;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE lms.import_jobs j SET rows_purged_at = now()
   WHERE j.rows_purged_at IS NULL
     AND j.status IN ('completed', 'completed_with_errors', 'failed', 'cancelled')
     AND COALESCE(j.finished_at, j.updated_at) < now() - make_interval(days => p_retention_days)
     AND NOT EXISTS (SELECT 1 FROM lms.import_rows r WHERE r.tenant_id = j.tenant_id AND r.import_id = j.id);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION lms.import_purge_rows(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.import_purge_rows(integer, integer) TO lms_app;

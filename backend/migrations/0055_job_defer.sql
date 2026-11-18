-- Step 14a: DEFER a running job without charging the attempt (docs/adr/0024-resilience.md).
-- job_release (migration 0010) hands a job back for IMMEDIATE re-claim: right for a worker that is shutting down. A job whose
-- external dependency is down (the email provider's circuit is open) must instead wait: it goes back to `queued` with
-- run_at = now() + p_delay_seconds and the attempt it consumed refunded, so an outage of any length never dead-letters mail.
-- Same guard as every worker function: it acts only while the caller still holds the lease (locked_by).
CREATE FUNCTION lms.job_defer(p_id uuid, p_worker text, p_delay_seconds integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.jobs j
     SET status = 'queued',
         attempts = GREATEST(j.attempts - 1, 0),
         run_at = now() + make_interval(secs => LEAST(GREATEST(p_delay_seconds, 1), 3600)),
         locked_by = NULL,
         locked_until = NULL
   WHERE j.id = p_id AND j.status = 'running' AND j.locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;
REVOKE ALL ON FUNCTION lms.job_defer(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.job_defer(uuid, text, integer) TO lms_app;

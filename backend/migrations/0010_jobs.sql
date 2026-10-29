-- Step 5: Postgres-backed job queue (FOR UPDATE SKIP LOCKED).
-- A job is a row. Business code enqueues it in ITS OWN transaction (the job exists exactly when the
-- business write does). The worker has no tenant context, so claiming / completing / failing go
-- through hardened SECURITY DEFINER functions (same rules as 0005): owner-owned, SET search_path =
-- lms, pg_temp, schema-qualified, EXECUTE revoked from PUBLIC and granted to lms_app only.
-- lms_app gets SELECT + INSERT (own tenant only) and NO update / delete: the queue's state machine is
-- only reachable through the functions.

CREATE TYPE lms.job_status AS ENUM ('queued', 'running', 'completed', 'dead');

CREATE TABLE lms.jobs (
  id uuid PRIMARY KEY,
  queue text NOT NULL CHECK (length(queue) BETWEEN 1 AND 100),
  -- NULL = system job (scheduled purges); otherwise the tenant the handler runs as
  tenant_id uuid REFERENCES lms.tenants (id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status lms.job_status NOT NULL DEFAULT 'queued',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  last_error text,
  result jsonb,
  locked_by text,
  locked_until timestamptz,
  -- at most one job per key, ever (until purged): scheduled jobs use "<name>:<time slot>"
  singleton_key text CHECK (length(singleton_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- claim: due queued jobs of a queue, oldest first
CREATE INDEX jobs_claim_idx ON lms.jobs (queue, run_at, id) WHERE status = 'queued';
-- crash recovery: running jobs whose lease ran out
CREATE INDEX jobs_lease_idx ON lms.jobs (queue, locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_singleton_key ON lms.jobs (singleton_key) WHERE singleton_key IS NOT NULL;
CREATE INDEX jobs_tenant_idx ON lms.jobs (tenant_id, queue, status) WHERE tenant_id IS NOT NULL;
-- retention purge
CREATE INDEX jobs_finished_idx ON lms.jobs (status, finished_at) WHERE status IN ('completed', 'dead');

ALTER TABLE lms.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.jobs FORCE ROW LEVEL SECURITY;

-- a tenant context can see and create ITS OWN jobs; system jobs (tenant_id NULL) are invisible to it
CREATE POLICY jobs_select ON lms.jobs FOR SELECT TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()));
CREATE POLICY jobs_insert ON lms.jobs FOR INSERT TO lms_app
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));

GRANT SELECT, INSERT ON lms.jobs TO lms_app;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    EXECUTE 'CREATE POLICY owner_all ON lms.jobs FOR ALL TO ' || quote_ident(current_user)
         || ' USING (true) WITH CHECK (true)';
  END IF;
END
$$;

-- ---------------------------------------------------------------- enqueue a SYSTEM job
-- Returns false when the singleton key already exists (the job for that slot was already enqueued).
CREATE FUNCTION lms.job_enqueue_system(
  p_id uuid, p_queue text, p_payload jsonb, p_run_at timestamptz, p_max_attempts integer,
  p_singleton_key text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
  VALUES (p_id, p_queue, NULL, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_run_at, now()),
          COALESCE(p_max_attempts, 5), p_singleton_key)
  ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

-- ---------------------------------------------------------------- claim
-- Takes up to p_limit due jobs of a queue (queued and due, OR running with an expired lease: the
-- worker that held them died), sets the lease and counts the attempt. A job whose lease expired
-- after its LAST attempt is dead-lettered instead of being run again.
CREATE FUNCTION lms.job_claim(p_queue text, p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (
  r_id uuid, r_queue text, r_tenant_id uuid, r_payload jsonb, r_attempts integer, r_max_attempts integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.jobs j
     SET status = 'dead', finished_at = now(), locked_by = NULL, locked_until = NULL,
         last_error = COALESCE(j.last_error, 'lease expired after the last attempt')
   WHERE j.id IN (
     SELECT x.id FROM lms.jobs x
      WHERE x.queue = p_queue AND x.status = 'running' AND x.locked_until < now()
        AND x.attempts >= x.max_attempts
      FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  WITH due AS (
    SELECT x.id FROM lms.jobs x
     WHERE x.queue = p_queue
       AND ((x.status = 'queued' AND x.run_at <= now())
            OR (x.status = 'running' AND x.locked_until < now()))
     ORDER BY x.run_at, x.id
     LIMIT LEAST(GREATEST(p_limit, 1), 100)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE lms.jobs j
     SET status = 'running', attempts = j.attempts + 1, locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds), started_at = now()
    FROM due
   WHERE j.id = due.id
  RETURNING j.id, j.queue, j.tenant_id, j.payload, j.attempts, j.max_attempts;
END
$$;

-- ---------------------------------------------------------------- finish / fail / heartbeat / release
-- Every one of these only applies while the caller STILL holds the lease (locked_by = p_worker, status
-- running): a worker that lost its lease cannot overwrite what the new holder does. They return
-- whether they applied.
CREATE FUNCTION lms.job_complete(p_id uuid, p_worker text, p_result jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.jobs j
     SET status = 'completed', finished_at = now(), result = p_result, locked_by = NULL,
         locked_until = NULL, last_error = NULL
   WHERE j.id = p_id AND j.status = 'running' AND j.locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

-- Retry with exponential backoff and jitter (base * 2^(attempt-1), capped), or dead-letter once the
-- attempts are used up. Returns 'retry' | 'dead' | 'lost'.
CREATE FUNCTION lms.job_fail(
  p_id uuid, p_worker text, p_error text, p_backoff_base_seconds integer, p_backoff_max_seconds integer
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_job lms.jobs%ROWTYPE;
  v_delay double precision;
BEGIN
  SELECT j.* INTO v_job FROM lms.jobs j
   WHERE j.id = p_id AND j.status = 'running' AND j.locked_by = p_worker FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  IF v_job.attempts >= v_job.max_attempts THEN
    UPDATE lms.jobs j SET status = 'dead', finished_at = now(), locked_by = NULL, locked_until = NULL,
           last_error = left(p_error, 2000)
     WHERE j.id = p_id;
    RETURN 'dead';
  END IF;
  v_delay := LEAST(p_backoff_base_seconds * power(2, v_job.attempts - 1), p_backoff_max_seconds)
             * (0.75 + random() * 0.5);
  UPDATE lms.jobs j SET status = 'queued', run_at = now() + make_interval(secs => v_delay),
         locked_by = NULL, locked_until = NULL, last_error = left(p_error, 2000)
   WHERE j.id = p_id;
  RETURN 'retry';
END
$$;

CREATE FUNCTION lms.job_extend_lease(p_id uuid, p_worker text, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.jobs j SET locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE j.id = p_id AND j.status = 'running' AND j.locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

-- Graceful shutdown: hands the job back WITHOUT charging the attempt.
CREATE FUNCTION lms.job_release(p_id uuid, p_worker text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE lms.jobs j
     SET status = 'queued', attempts = GREATEST(j.attempts - 1, 0), locked_by = NULL, locked_until = NULL
   WHERE j.id = p_id AND j.status = 'running' AND j.locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END
$$;

-- ---------------------------------------------------------------- retention
-- Deletes at most p_batch finished jobs per call: completed ones older than p_completed_days and dead
-- ones older than p_dead_days. lms_app has no DELETE on the table.
CREATE FUNCTION lms.job_purge(p_completed_days integer, p_dead_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  WITH old AS (
    SELECT j.id FROM lms.jobs j
     WHERE (j.status = 'completed' AND j.finished_at < now() - make_interval(days => p_completed_days))
        OR (j.status = 'dead' AND j.finished_at < now() - make_interval(days => p_dead_days))
     ORDER BY j.finished_at
     LIMIT LEAST(GREATEST(p_batch, 1), 10000)
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM lms.jobs j USING old WHERE j.id = old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'lms'::regnamespace AND p.proname LIKE 'job\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO lms_app', f.sig);
  END LOOP;
END
$$;

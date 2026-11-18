-- Step 14a: production hardening. Part 1 of 1.
--  1. the SHARED rate limiter: one UNLOGGED counter table behind ONE hardened definer function (docs/adr/0022-shared-rate-limiting.md);
--  2. the operations gauges behind GET /metrics (queue depth and age, email backlog, rollup lag, video backlog), read across
--     colleges by a definer function that returns COUNTS and AGES only (no tenant ids, no names, no payloads).
--
-- UNLOGGED = not written to the WAL (fast, no replication cost) and EMPTIED on a crash or a failover. That is the intended
-- trade: a limiter that forgets everyone for one window after a crash is harmless; a limiter that costs a WAL write per request is not.

-- ------------------------------------------------------------------ the shared counters
CREATE UNLOGGED TABLE lms.rate_limit_counters (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 300),
  hits integer NOT NULL CHECK (hits >= 0),
  window_start timestamptz NOT NULL,
  window_ms integer NOT NULL CHECK (window_ms BETWEEN 1000 AND 86400000)
);
CREATE INDEX rate_limit_counters_window_idx ON lms.rate_limit_counters (window_start);

-- like user_credentials: RLS enabled and forced, NO policy and NO grant for lms_app; only the functions below touch it
ALTER TABLE lms.rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.rate_limit_counters FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.rate_limit_counters FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;

-- ONE statement per call (an autocommit round trip). A fixed window per key: the first hit opens it, later hits add `p_delta`
-- (a batch of local hits from one API instance) until it has run for `p_window_ms`; then the next hit opens a new one.
-- Returns the total in the window and the milliseconds it has left.
CREATE FUNCTION lms.rate_limit_hit(p_key text, p_window_ms integer, p_delta integer)
RETURNS TABLE (hits integer, ttl_ms integer)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = lms, pg_temp
AS $$
  INSERT INTO lms.rate_limit_counters AS c (key, hits, window_start, window_ms)
  VALUES (p_key, greatest(p_delta, 1), clock_timestamp(), p_window_ms)
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN c.window_start + c.window_ms * interval '1 millisecond' <= clock_timestamp()
                THEN greatest(p_delta, 1) ELSE c.hits + greatest(p_delta, 1) END,
    window_start = CASE WHEN c.window_start + c.window_ms * interval '1 millisecond' <= clock_timestamp()
                        THEN clock_timestamp() ELSE c.window_start END,
    window_ms = excluded.window_ms
  RETURNING c.hits,
            greatest(0, ceil(extract(epoch FROM (c.window_start + c.window_ms * interval '1 millisecond' - clock_timestamp())) * 1000))::integer;
$$;
REVOKE ALL ON FUNCTION lms.rate_limit_hit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.rate_limit_hit(text, integer, integer) TO lms_app;

-- the worker removes windows that ended more than a minute ago, a batch at a time
CREATE FUNCTION lms.rate_limit_purge(p_batch integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = lms, pg_temp
AS $$
  WITH doomed AS (
    SELECT key FROM lms.rate_limit_counters
    WHERE window_start + window_ms * interval '1 millisecond' < clock_timestamp() - interval '1 minute'
    LIMIT least(greatest(p_batch, 1), 10000)
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM lms.rate_limit_counters c USING doomed d WHERE c.key = d.key RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;
REVOKE ALL ON FUNCTION lms.rate_limit_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.rate_limit_purge(integer) TO lms_app;

-- ------------------------------------------------------------------ operations gauges (read across colleges, counts and ages only)
-- metric: a stable name; label: the queue / status it is about ('' = none); value: a number (seconds for ages).
CREATE FUNCTION lms.ops_metrics()
RETURNS TABLE (metric text, label text, value double precision)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = lms, pg_temp
AS $$
  -- job queues: due work waiting, how long the oldest has waited, work running, dead letters
  SELECT 'job_queue_depth', j.queue, count(*)::double precision
    FROM lms.jobs j WHERE j.status = 'queued' AND j.run_at <= now() GROUP BY j.queue
  UNION ALL
  SELECT 'job_queue_oldest_age_seconds', j.queue,
         extract(epoch FROM now() - min(j.run_at))::double precision
    FROM lms.jobs j WHERE j.status = 'queued' AND j.run_at <= now() GROUP BY j.queue
  UNION ALL
  SELECT 'job_running', j.queue, count(*)::double precision
    FROM lms.jobs j WHERE j.status = 'running' GROUP BY j.queue
  UNION ALL
  SELECT 'job_dead', j.queue, count(*)::double precision
    FROM lms.jobs j WHERE j.status = 'dead' GROUP BY j.queue
  UNION ALL
  -- the email outbox: what is waiting to be sent (queued) or stuck in flight (sending), and the age of the oldest due row
  SELECT 'email_outbox_backlog', o.status, count(*)::double precision
    FROM lms.email_outbox o WHERE o.status IN ('queued', 'sending') AND o.run_after <= now() GROUP BY o.status
  UNION ALL
  SELECT 'email_outbox_oldest_age_seconds', '',
         coalesce(extract(epoch FROM now() - min(o.run_after)), 0)::double precision
    FROM lms.email_outbox o WHERE o.status = 'queued' AND o.run_after <= now()
  UNION ALL
  SELECT 'email_outbox_dead', '', count(*)::double precision FROM lms.email_outbox o WHERE o.status = 'dead'
  UNION ALL
  -- the rollups: how far behind the oldest college's learner rollup is
  SELECT 'rollup_lag_seconds', '',
         coalesce(extract(epoch FROM now() - min(r.as_of)), 0)::double precision
    FROM lms.rollup_state r WHERE r.kind = 'learner'
  UNION ALL
  -- video: assets waiting for or in the transcoder, and the age of the oldest
  SELECT 'video_backlog', 'processing', count(*)::double precision FROM lms.video_assets v WHERE v.status = 'processing'
  UNION ALL
  SELECT 'video_oldest_age_seconds', '',
         coalesce(extract(epoch FROM now() - min(v.updated_at)), 0)::double precision
    FROM lms.video_assets v WHERE v.status = 'processing'
$$;
REVOKE ALL ON FUNCTION lms.ops_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.ops_metrics() TO lms_app;

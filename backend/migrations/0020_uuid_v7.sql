-- Database-side UUIDv7 (RFC 9562), portable: it does not use native uuidv7() (PostgreSQL 18 only; ADR 0014 pins 17).
-- Layout: 48-bit unix time in milliseconds | version 7 | 12 bits = the microsecond within the millisecond (RFC 9562
-- 6.2 method 3: keeps ids created in one statement ordered) | variant 10 | 62 random bits.
-- App-side ids keep using the `uuidv7` package; this function is for rows created INSIDE a statement (the enrolment
-- sync, content copy, queued jobs, audit rows of set-based statements).
CREATE FUNCTION lms.uuid_v7()
RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  micros bigint := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  ms bigint := micros / 1000;
  frac int := ((micros % 1000) * 4096 / 1000)::int;
  b bytea := uuid_send(gen_random_uuid());  -- 16 random bytes (the CSPRNG of gen_random_uuid)
BEGIN
  b := set_byte(b, 0, ((ms >> 40) & 255)::int);
  b := set_byte(b, 1, ((ms >> 32) & 255)::int);
  b := set_byte(b, 2, ((ms >> 24) & 255)::int);
  b := set_byte(b, 3, ((ms >> 16) & 255)::int);
  b := set_byte(b, 4, ((ms >> 8) & 255)::int);
  b := set_byte(b, 5, (ms & 255)::int);
  b := set_byte(b, 6, 112 | (frac >> 8));                        -- 0x70 | high 4 bits of the fraction
  b := set_byte(b, 7, frac & 255);
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);              -- variant 10xx
  RETURN encode(b, 'hex')::uuid;
END
$$;
REVOKE ALL ON FUNCTION lms.uuid_v7() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.uuid_v7() TO lms_app;

-- the enrolment marker queues its job with a v7 id too
CREATE OR REPLACE FUNCTION lms.course_sync_mark(p_tenants uuid[], p_memberships uuid[])
RETURNS void
LANGUAGE sql SET search_path = lms, pg_temp
AS $$
  WITH changed AS (
    SELECT DISTINCT t.tenant_id, t.membership_id FROM unnest(p_tenants, p_memberships) AS t(tenant_id, membership_id)
  ), marked AS (
    INSERT INTO lms.course_sync_pending (tenant_id, membership_id)
    SELECT tenant_id, membership_id FROM changed
    ON CONFLICT DO NOTHING
  )
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, max_attempts)
  SELECT lms.uuid_v7(), 'courses.sync', c.tenant_id, '{}'::jsonb, 5
    FROM (SELECT DISTINCT tenant_id FROM changed) c
   WHERE NOT EXISTS (SELECT 1 FROM lms.jobs j
                      WHERE j.tenant_id = c.tenant_id AND j.queue = 'courses.sync' AND j.status = 'queued')
$$;

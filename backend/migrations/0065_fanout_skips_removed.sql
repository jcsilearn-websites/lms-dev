-- Step 14b-1, part 3c: notify_fanout never notifies a REMOVED member (an erased member is a removed member).
--
-- Until now the event triggers chose their recipients (active members) and notify_fanout trusted them; the worker re-checked the
-- membership when it sent. A caller that forgot the status filter would have written a bell row and put the member's ADDRESS into the
-- outbox of a person who asked to be erased. The filter now lives in the one function every event goes through.
--
-- CREATE OR REPLACE keeps the owner and the grants; the SET clauses are restated; the migration CHECKS that proconfig, the ACL, SECURITY
-- DEFINER, volatility and owner are the same afterwards (it raises and rolls back otherwise), as migration 0061 does.

CREATE TEMP TABLE _fanout_before ON COMMIT DROP AS
SELECT p.oid::regprocedure::text AS sig,
       (SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c) AS cfg,
       coalesce(p.proacl::text, '') AS acl, p.prosecdef, p.provolatile, p.proowner::regrole::text AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms' AND p.proname = 'notify_fanout';

CREATE OR REPLACE FUNCTION lms.notify_fanout(p_items lms.notify_item[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_items IS NULL OR cardinality(p_items) = 0 THEN RETURN 0; END IF;
  WITH x AS MATERIALIZED (
    SELECT DISTINCT ON (i.tenant_id, i.user_id, i.dedupe_key) i.*
      FROM unnest(p_items) i
     WHERE i.tenant_id IS NOT NULL AND i.user_id IS NOT NULL
     ORDER BY i.tenant_id, i.user_id, i.dedupe_key),
  st AS MATERIALIZED (
    SELECT t.tenant_id, lms.notify_settings(t.tenant_id) AS s, lms.tenant_tz(t.tenant_id) AS tz,
           lms.notify_quiet_release(lms.notify_settings(t.tenant_id), lms.tenant_tz(t.tenant_id), now()) AS quiet_rel
      FROM (SELECT DISTINCT tenant_id FROM x) t),
  eff AS MATERIALIZED (
    SELECT x.*, st.s, st.tz, st.quiet_rel, u.email AS to_email,
           CASE WHEN x.category = 'security' THEN true
                ELSE coalesce(p.in_app, (st.s -> 'defaults' -> x.category ->> 'inApp')::boolean, true) END AS want_app,
           CASE WHEN x.category = 'security' THEN true
                ELSE coalesce(p.email, (st.s -> 'defaults' -> x.category ->> 'email')::boolean, true) END AS want_email
      FROM x
      JOIN st ON st.tenant_id = x.tenant_id
      -- a REMOVED member (also one who was erased) is never notified, whatever the caller selected: no bell row, no address in the outbox
      CROSS JOIN LATERAL (SELECT 1 FROM lms.tenant_memberships mm
                           WHERE mm.tenant_id = x.tenant_id AND mm.user_id = x.user_id AND mm.status <> 'removed' OFFSET 0) mem
      CROSS JOIN LATERAL (SELECT uu.email FROM lms.users uu WHERE uu.id = x.user_id OFFSET 0) u
      LEFT JOIN LATERAL (SELECT pp.email, pp.in_app FROM lms.notification_preferences pp
                          WHERE pp.tenant_id = x.tenant_id AND pp.user_id = x.user_id AND pp.category = x.category
                         OFFSET 0) p ON true),
  ins_app AS (
    INSERT INTO lms.notifications (id, tenant_id, user_id, category, type, params, link, dedupe_key)
    SELECT lms.uuid_v7(), e.tenant_id, e.user_id, e.category, e.type, coalesce(e.params, '{}'::jsonb), e.link, e.dedupe_key
      FROM eff e WHERE coalesce(e.in_app, true) AND e.want_app
    ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING
    RETURNING 1),
  mail AS (
    SELECT e.*, CASE WHEN e.category = 'security' THEN now() ELSE e.quiet_rel END AS rel
      FROM eff e
     WHERE e.email_template IS NOT NULL AND e.want_email AND NOT lms.email_suppressed(e.to_email, e.category)),
  ins_mail AS (
    INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params, status,
                                  run_after, expires_at, skip_reason)
    SELECT lms.uuid_v7(), m.tenant_id, m.dedupe_key || ':' || m.user_id, m.user_id, m.to_email, m.category, m.email_template,
           coalesce(m.params, '{}'::jsonb) || CASE WHEN m.link IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('link', m.link) END,
           CASE WHEN m.expires_at IS NOT NULL AND m.rel >= m.expires_at THEN 'expired' ELSE 'queued' END,
           m.rel, m.expires_at,
           CASE WHEN m.expires_at IS NOT NULL AND m.rel >= m.expires_at THEN 'quiet_hours_past_deadline' END
      FROM mail m
    ON CONFLICT ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key) DO NOTHING
    RETURNING id, tenant_id, run_after, status),
  jobs AS (
    INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
    SELECT lms.uuid_v7(), 'email.send', i.tenant_id, jsonb_build_object('outboxId', i.id), i.run_after, 5, 'email:' || i.id
      FROM ins_mail i WHERE i.status = 'queued'
    ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL DO NOTHING
    RETURNING 1)
  SELECT (SELECT count(*) FROM jobs) + 0 * (SELECT count(*) FROM ins_app) INTO n;
  RETURN n;
END
$$;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(b.sig, '; ') INTO bad
    FROM _fanout_before b
    LEFT JOIN (SELECT p.oid::regprocedure::text AS sig,
                      (SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c) AS cfg,
                      coalesce(p.proacl::text, '') AS acl, p.prosecdef, p.provolatile, p.proowner::regrole::text AS owner
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lms') a ON a.sig = b.sig
   WHERE a.sig IS NULL OR a.cfg IS DISTINCT FROM b.cfg OR a.acl IS DISTINCT FROM b.acl OR a.prosecdef IS DISTINCT FROM b.prosecdef
      OR a.provolatile IS DISTINCT FROM b.provolatile OR a.owner IS DISTINCT FROM b.owner;
  IF bad IS NOT NULL OR (SELECT count(*) FROM _fanout_before) <> 1 THEN
    RAISE EXCEPTION 'a replaced function lost a setting or a grant: %', coalesce(bad, 'notify_fanout not found');
  END IF;
END
$$;

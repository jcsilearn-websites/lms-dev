-- Step 13: notifications and email. Part 1: the tables, the college settings, the ONE fan-out function every event goes
-- through, the email outbox (claim / mark for the worker), suppressions, the provider webhook ingest, unsubscribe and purges.
-- Reasoning: docs/adr/0021-notifications-email.md.
--
-- Categories (preferences are per category and channel): security (mandatory, email only), learning_deadlines,
-- learning_grades, learning_content, teaching_grading, teaching_updates, admin.
-- PRIVACY: params never carry marks, scores, feedback text, override / waiver / extension / accommodation reasons or at-risk
-- evidence. They carry titles, counts and links ("something is ready, open the LMS"). A sentinel test checks every row.

-- ------------------------------------------------------------------ the verified From address of a college (platform-managed)
-- Set only by a platform admin (platform_set_email_sender) once JCS authenticated the domain at the provider (SPF / DKIM).
-- lms_app has SELECT only on lms.tenants, so a college cannot set it itself.
ALTER TABLE lms.tenants ADD COLUMN email_from text
  CHECK (email_from IS NULL OR (email_from = lower(email_from) AND length(email_from) <= 254
                                AND email_from ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'));

-- ------------------------------------------------------------------ in-app notifications (one row per member and event)
CREATE TABLE lms.notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  user_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('security', 'learning_deadlines', 'learning_grades', 'learning_content',
                                             'teaching_grading', 'teaching_updates', 'admin')),
  type text NOT NULL CHECK (type ~ '^[a-z_]{1,40}$'),
  -- display-safe values only (titles, counts, dates); never marks, feedback or reasons
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(params::text) <= 4000),
  -- a path inside the college's site ("/offerings/..."), never an absolute URL
  link text CHECK (link IS NULL OR (length(link) <= 500 AND link ~ '^/[A-Za-z0-9]')),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_dedupe_key UNIQUE (tenant_id, user_id, dedupe_key),
  -- ephemeral rows: they may cascade (memberships are never deleted by the app anyway)
  CONSTRAINT notifications_member_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES lms.tenant_memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX notifications_list_idx ON lms.notifications (tenant_id, user_id, id DESC);
-- the bell: an index-only count of the unread rows of one member
CREATE INDEX notifications_unread_idx ON lms.notifications (tenant_id, user_id, id DESC) WHERE read_at IS NULL;
-- the retention purge runs across colleges (a system job through a definer function)
CREATE INDEX notifications_read_purge_idx ON lms.notifications (read_at) WHERE read_at IS NOT NULL;

-- ------------------------------------------------------------------ preferences (only the member's overrides are stored)
CREATE TABLE lms.notification_preferences (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  user_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('learning_deadlines', 'learning_grades', 'learning_content',
                                             'teaching_grading', 'teaching_updates', 'admin')),
  email boolean NOT NULL,
  in_app boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, category),
  CONSTRAINT notification_preferences_member_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES lms.tenant_memberships (tenant_id, user_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ the email outbox
-- One row per (event, recipient), inserted in the SAME transaction as the event (by notify_fanout or email_enqueue_security),
-- together with its `email.send` job. idempotency_key is unique per college (NULL college = admin-host mail): the same event
-- twice never makes a second row. NEVER holds a secret: invite / reset tokens are minted by the worker when it sends.
CREATE TABLE lms.email_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES lms.tenants (id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  user_id uuid REFERENCES lms.users (id) ON DELETE CASCADE,
  to_email text NOT NULL CHECK (to_email = lower(to_email) AND length(to_email) BETWEEN 3 AND 320),
  category text NOT NULL CHECK (category IN ('security', 'learning_deadlines', 'learning_grades', 'learning_content',
                                             'teaching_grading', 'teaching_updates', 'admin')),
  template text NOT NULL CHECK (template ~ '^[a-z_]{1,40}$'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(params::text) <= 8000),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'suppressed', 'skipped', 'expired', 'dead')),
  -- quiet hours: not before this instant (security mail: at once)
  run_after timestamptz NOT NULL DEFAULT now(),
  -- a reminder is pointless after its deadline: never sent from this instant on
  expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider text CHECK (length(provider) <= 40),
  provider_message_id text CHECK (length(provider_message_id) <= 300),
  skip_reason text CHECK (length(skip_reason) <= 100),
  last_error text CHECK (length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_outbox_key ON lms.email_outbox
  ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key);
CREATE INDEX email_outbox_created_idx ON lms.email_outbox (created_at);
CREATE INDEX email_outbox_message_idx ON lms.email_outbox (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ------------------------------------------------------------------ suppressions (global: a bounce is a fact about an address)
-- bounce: nothing is sent to the address any more, security mail included (a dead address hurts every college's reputation).
-- complaint: nothing but security mail (a member must still be able to reset their password). Cleared only by an admin; the
-- cleared rows stay as history (reason and times).
CREATE TABLE lms.email_suppressions (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  reason text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),
  detail text CHECK (length(detail) <= 300),
  provider text CHECK (length(provider) <= 40),
  -- the college whose mail produced the event (informative)
  source_tenant_id uuid REFERENCES lms.tenants (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES lms.users (id) ON DELETE SET NULL,
  cleared_in_tenant uuid REFERENCES lms.tenants (id)
);
CREATE UNIQUE INDEX email_suppressions_active ON lms.email_suppressions (email) WHERE cleared_at IS NULL;
CREATE INDEX email_suppressions_created_idx ON lms.email_suppressions (created_at DESC, id DESC);

-- provider events already applied (a replayed webhook is a no-op); purged with the outbox
CREATE TABLE lms.email_events (
  provider text NOT NULL CHECK (length(provider) <= 40),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('bounce', 'complaint', 'delivered', 'deferred', 'dropped', 'other')),
  email text CHECK (length(email) <= 320),
  outbox_id uuid,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX email_events_received_idx ON lms.email_events (received_at);

-- ------------------------------------------------------------------ platform admins (no college): their own small inbox
CREATE TABLE lms.platform_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES lms.users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type ~ '^[a-z_]{1,40}$'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(params::text) <= 4000),
  link text CHECK (link IS NULL OR (length(link) <= 500 AND link ~ '^/[A-Za-z0-9]')),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT platform_notifications_dedupe_key UNIQUE (user_id, dedupe_key)
);
CREATE INDEX platform_notifications_list_idx ON lms.platform_notifications (user_id, id DESC);
CREATE INDEX platform_notifications_unread_idx ON lms.platform_notifications (user_id, id DESC) WHERE read_at IS NULL;

-- ------------------------------------------------------------------ scheduling state (worker only)
-- content that became visible to learners, waiting for the next daily digest (written by a trigger, see 0053)
CREATE TABLE lms.notify_content_marks (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  visible_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, item_id)
);
CREATE INDEX notify_content_marks_due_idx ON lms.notify_content_marks (tenant_id, visible_at);
-- the scan's high-water mark per college: a threshold (due - 24 h, ...) is acted on when it falls in (scanned_until, now]
CREATE TABLE lms.notify_scan_state (
  tenant_id uuid PRIMARY KEY REFERENCES lms.tenants (id),
  scanned_until timestamptz NOT NULL
);
-- digests and weekly summaries that already ran (per college, kind and LOCAL date)
CREATE TABLE lms.notify_runs (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  local_date date NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, local_date)
);

-- ------------------------------------------------------------------ RLS and grants
ALTER TABLE lms.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE lms.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.notification_preferences FORCE ROW LEVEL SECURITY;
-- a member reads and marks only their OWN notifications, in the current college
CREATE POLICY notifications_own ON lms.notifications FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()) AND user_id = (SELECT lms.current_user_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()) AND user_id = (SELECT lms.current_user_id()));
CREATE POLICY notification_preferences_own ON lms.notification_preferences FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()) AND user_id = (SELECT lms.current_user_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()) AND user_id = (SELECT lms.current_user_id()));
GRANT SELECT ON lms.notifications TO lms_app;
GRANT UPDATE (read_at) ON lms.notifications TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.notification_preferences TO lms_app;
GRANT UPDATE (email, in_app, updated_at) ON lms.notification_preferences TO lms_app;

-- reachable ONLY through the definer functions below: no policy and no privilege for lms_app
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_outbox', 'email_suppressions', 'email_events', 'platform_notifications',
                           'notify_content_marks', 'notify_scan_state', 'notify_runs']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences', 'email_outbox', 'email_suppressions', 'email_events',
                           'platform_notifications', 'notify_content_marks', 'notify_scan_state', 'notify_runs']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------------ the college's notification settings
-- tenant_settings key 'notifications': {defaults: {<category>: {email, inApp}}, quietHours: {enabled, start, end},
-- digestHour, fromName, replyTo}. This returns the stored value merged over the built-in defaults.
CREATE FUNCTION lms.notify_settings(p_tenant uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  WITH s AS (SELECT coalesce((SELECT value FROM lms.tenant_settings WHERE tenant_id = p_tenant AND key = 'notifications'),
                             '{}'::jsonb) AS v),
  d AS (SELECT jsonb_build_object(
                 'learning_deadlines', jsonb_build_object('email', true, 'inApp', true),
                 'learning_grades', jsonb_build_object('email', true, 'inApp', true),
                 'learning_content', jsonb_build_object('email', true, 'inApp', true),
                 'teaching_grading', jsonb_build_object('email', true, 'inApp', true),
                 'teaching_updates', jsonb_build_object('email', true, 'inApp', true),
                 'admin', jsonb_build_object('email', true, 'inApp', true)) AS v)
  SELECT jsonb_build_object(
           'defaults', (SELECT jsonb_object_agg(k, d.v -> k || coalesce(s.v -> 'defaults' -> k, '{}'::jsonb))
                          FROM jsonb_object_keys(d.v) k),
           'quietHours', jsonb_build_object('enabled', true, 'start', '22:00', 'end', '07:00')
                         || coalesce(s.v -> 'quietHours', '{}'::jsonb),
           'digestHour', coalesce(s.v -> 'digestHour', '7'::jsonb),
           'fromName', coalesce(s.v -> 'fromName', 'null'::jsonb),
           'replyTo', coalesce(s.v -> 'replyTo', 'null'::jsonb))
    FROM s, d
$$;
REVOKE ALL ON FUNCTION lms.notify_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_settings(uuid) TO lms_app;

-- Quiet hours: p_at when it is outside them, else the instant they end, in the college's zone. A window may wrap midnight
-- (22:00-07:00). The local end time is converted back with AT TIME ZONE, so a DST change is handled by the zone database.
CREATE FUNCTION lms.notify_quiet_release(p_settings jsonb, p_tz text, p_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  q jsonb := p_settings -> 'quietHours';
  s time;
  e time;
  l timestamp := p_at AT TIME ZONE p_tz;
  t time := (p_at AT TIME ZONE p_tz)::time;
BEGIN
  IF q IS NULL OR NOT coalesce((q ->> 'enabled')::boolean, false) THEN RETURN p_at; END IF;
  s := (q ->> 'start')::time;
  e := (q ->> 'end')::time;
  IF s = e THEN RETURN p_at; END IF;
  IF s < e THEN
    IF t >= s AND t < e THEN RETURN (l::date + e) AT TIME ZONE p_tz; END IF;
    RETURN p_at;
  END IF;
  -- wraps midnight
  IF t >= s THEN RETURN (l::date + 1 + e) AT TIME ZONE p_tz; END IF;
  IF t < e THEN RETURN (l::date + e) AT TIME ZONE p_tz; END IF;
  RETURN p_at;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_quiet_release(jsonb, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_quiet_release(jsonb, text, timestamptz) TO lms_app;

-- Is the address suppressed for this category? bounce / manual: always; complaint: everything but security mail.
CREATE FUNCTION lms.email_suppressed(p_email text, p_category text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM lms.email_suppressions s
                  WHERE s.email = lower(p_email) AND s.cleared_at IS NULL
                    AND (s.reason <> 'complaint' OR p_category <> 'security'))
$$;
REVOKE ALL ON FUNCTION lms.email_suppressed(text, text) FROM PUBLIC;

-- ------------------------------------------------------------------ the fan-out (every event goes through here)
-- One element per (recipient, event). email_template NULL = in-app only; in_app false = email only (security mail).
CREATE TYPE lms.notify_item AS (
  tenant_id uuid,
  user_id uuid,
  category text,
  type text,
  params jsonb,
  link text,
  dedupe_key text,
  email_template text,
  expires_at timestamptz,
  in_app boolean
);

-- Set-based: ONE statement writes the in-app rows the members want, the outbox rows they want (one per EVENT AND RECIPIENT,
-- minus suppressed addresses;
-- run_after = the end of the college's quiet hours, security mail at once; already expired = recorded as 'expired', no job)
-- and an `email.send` job per queued row. ON CONFLICT on the dedupe / idempotency keys makes a repeated event a no-op.
-- Returns the number of jobs enqueued. Called by the event triggers and the scan (migration 0053), never with user input.
CREATE FUNCTION lms.notify_fanout(p_items lms.notify_item[])
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
REVOKE ALL ON FUNCTION lms.notify_fanout(lms.notify_item[]) FROM PUBLIC;

-- ------------------------------------------------------------------ security mail (explicit path)
-- Security mail is mandatory (no preference, no quiet hours) and is sent unless the address BOUNCED. Templates:
--   invite            (tenant, the PENDING membership's user; the worker mints the token when it sends)
--   password_reset    (tenant or NULL = admin host; the worker mints the token)
--   password_changed  (tenant or NULL)
--   admin_promoted    (tenant)
-- Called by the audit triggers (0053) and, for a reset request and an imported member's invite, by lms_app (service code).
CREATE FUNCTION lms.email_enqueue_security(p_tenant uuid, p_user uuid, p_template text, p_params jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_email text;
  v_id uuid := lms.uuid_v7();
BEGIN
  IF p_template NOT IN ('invite', 'password_reset', 'password_changed', 'admin_promoted') THEN
    RAISE EXCEPTION 'not a security template: %', p_template USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'idempotency key required' USING ERRCODE = '22023';
  END IF;
  -- an invite goes only to a PENDING member of that college; anything else to a member of it (or, on the admin host, a user)
  IF p_tenant IS NOT NULL THEN
    SELECT u.email INTO v_email FROM lms.tenant_memberships m JOIN lms.users u ON u.id = m.user_id
     WHERE m.tenant_id = p_tenant AND m.user_id = p_user
       AND (CASE WHEN p_template = 'invite' THEN m.status = 'pending' ELSE m.status <> 'removed' END);
  ELSE
    SELECT u.email INTO v_email FROM lms.users u WHERE u.id = p_user;
  END IF;
  IF v_email IS NULL OR lms.email_suppressed(v_email, 'security') THEN RETURN false; END IF;
  INSERT INTO lms.email_outbox (id, tenant_id, idempotency_key, user_id, to_email, category, template, params)
  VALUES (v_id, p_tenant, p_key, p_user, v_email, 'security', p_template, coalesce(p_params, '{}'::jsonb))
  ON CONFLICT ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), idempotency_key) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
  VALUES (lms.uuid_v7(), 'email.send', p_tenant, jsonb_build_object('outboxId', v_id), now(), 5, 'email:' || v_id);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION lms.email_enqueue_security(uuid, uuid, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_enqueue_security(uuid, uuid, text, jsonb, text) TO lms_app;

-- ------------------------------------------------------------------ the worker: claim one outbox row
-- Decides, at SEND time, everything that may have changed since the event: suppression, the member's preference (a change is
-- effective at once), the membership (removed / suspended members get nothing but security mail), quiet hours (a retry that
-- lands inside them is deferred: a new job at their end), the expiry. verdict:
--   send      -> status 'sending', attempts + 1, the render data is returned
--   deferred  -> a job was queued for the end of quiet hours
--   done      -> already final (sent / suppressed / skipped / expired / dead): a retry of a finished row does nothing
--   suppressed / skipped / expired -> recorded on the row, nothing to send
-- A row found in 'sending' was claimed by an attempt that may have reached the provider (crash after the hand-over): it is sent
-- again with the SAME Message-ID (receivers collapse duplicates); the window is milliseconds wide (ADR 0021).
CREATE FUNCTION lms.email_claim(p_id uuid)
RETURNS TABLE (verdict text, tenant_id uuid, user_id uuid, to_email text, category text, template text, params jsonb,
               attempts integer, tenant_slug text, tenant_name text, branding jsonb, email_from text, from_name text,
               reply_to text, time_zone text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  o lms.email_outbox%ROWTYPE;
  v_s jsonb;
  v_tz text;
  v_rel timestamptz;
  v_ok boolean;
  v_slug text;
  v_name text;
  v_from text;
  v_brand jsonb;
  v_tstatus text;
BEGIN
  SELECT * INTO o FROM lms.email_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND OR o.status IN ('sent', 'suppressed', 'skipped', 'expired', 'dead') THEN
    RETURN QUERY SELECT 'done'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::integer,
                        NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF lms.email_suppressed(o.to_email, o.category) THEN
    UPDATE lms.email_outbox SET status = 'suppressed', updated_at = now() WHERE id = p_id;
    RETURN QUERY SELECT 'suppressed'::text, o.tenant_id, o.user_id, o.to_email, o.category, o.template, NULL::jsonb, o.attempts,
                        NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, o.created_at;
    RETURN;
  END IF;
  IF o.tenant_id IS NOT NULL THEN
    SELECT t.slug, t.name, t.email_from, t.status::text INTO v_slug, v_name, v_from, v_tstatus FROM lms.tenants t WHERE t.id = o.tenant_id;
    v_s := lms.notify_settings(o.tenant_id);
    v_tz := lms.tenant_tz(o.tenant_id);
    SELECT s.value INTO v_brand FROM lms.tenant_settings s WHERE s.tenant_id = o.tenant_id AND s.key = 'branding';
  END IF;
  -- college mail that is not security mail: membership, preference, quiet hours, expiry. (Platform mail has no college:
  -- it goes to platform admins at once.)
  IF o.category <> 'security' AND o.tenant_id IS NOT NULL THEN
    -- the member must still be an active member of an active college, and still want this category by email
    SELECT (m.status = 'active' AND v_tstatus = 'active'
            AND coalesce(p.email, (v_s -> 'defaults' -> o.category ->> 'email')::boolean, true))
      INTO v_ok
      FROM lms.tenant_memberships m
      LEFT JOIN lms.notification_preferences p
        ON p.tenant_id = m.tenant_id AND p.user_id = m.user_id AND p.category = o.category
     WHERE m.tenant_id = o.tenant_id AND m.user_id = o.user_id;
    IF NOT coalesce(v_ok, false) THEN
      UPDATE lms.email_outbox SET status = 'skipped', skip_reason = 'preference_or_membership', updated_at = now() WHERE id = p_id;
      RETURN QUERY SELECT 'skipped'::text, o.tenant_id, o.user_id, o.to_email, o.category, o.template, NULL::jsonb, o.attempts,
                          NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, o.created_at;
      RETURN;
    END IF;
    v_rel := lms.notify_quiet_release(v_s, v_tz, now());
    IF o.expires_at IS NOT NULL AND greatest(v_rel, now()) >= o.expires_at THEN
      UPDATE lms.email_outbox SET status = 'expired', skip_reason = 'past_deadline', updated_at = now() WHERE id = p_id;
      RETURN QUERY SELECT 'expired'::text, o.tenant_id, o.user_id, o.to_email, o.category, o.template, NULL::jsonb, o.attempts,
                          NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, o.created_at;
      RETURN;
    END IF;
    IF v_rel > now() THEN
      UPDATE lms.email_outbox SET status = 'queued', run_after = v_rel, updated_at = now() WHERE id = p_id;
      INSERT INTO lms.jobs (id, queue, tenant_id, payload, run_at, max_attempts, singleton_key)
      VALUES (lms.uuid_v7(), 'email.send', o.tenant_id, jsonb_build_object('outboxId', o.id), v_rel, 5,
              'email:' || o.id || ':' || floor(extract(epoch FROM v_rel))::bigint)
      ON CONFLICT (singleton_key) WHERE singleton_key IS NOT NULL DO NOTHING;
      RETURN QUERY SELECT 'deferred'::text, o.tenant_id, o.user_id, o.to_email, o.category, o.template, NULL::jsonb, o.attempts,
                          NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text, o.created_at;
      RETURN;
    END IF;
  END IF;
  UPDATE lms.email_outbox SET status = 'sending', attempts = attempts + 1, claimed_at = now(), updated_at = now()
   WHERE id = p_id;
  RETURN QUERY SELECT 'send'::text, o.tenant_id, o.user_id, o.to_email, o.category, o.template, o.params, o.attempts + 1,
                      v_slug, v_name, v_brand, v_from, v_s ->> 'fromName', v_s ->> 'replyTo', coalesce(v_tz, 'UTC'), o.created_at;
END
$$;
REVOKE ALL ON FUNCTION lms.email_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_claim(uuid) TO lms_app;

-- The outcome of a send: 'sent' (with the provider's id), 'retry' (back to queued, the error kept; the job retries), 'dead'
-- (permanently refused or out of attempts), 'skipped' (e.g. an invite whose member is no longer pending).
CREATE FUNCTION lms.email_mark(p_id uuid, p_outcome text, p_provider text, p_message_id text, p_error text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  IF p_outcome NOT IN ('sent', 'retry', 'dead', 'skipped') THEN
    RAISE EXCEPTION 'bad outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  UPDATE lms.email_outbox o
     SET status = CASE p_outcome WHEN 'retry' THEN 'queued' ELSE p_outcome END,
         provider = coalesce(p_provider, o.provider),
         provider_message_id = coalesce(left(p_message_id, 300), o.provider_message_id),
         last_error = CASE WHEN p_error IS NULL THEN o.last_error ELSE left(p_error, 500) END,
         skip_reason = CASE WHEN p_outcome = 'skipped' THEN left(p_error, 100) ELSE o.skip_reason END,
         sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE o.sent_at END,
         updated_at = now()
   WHERE o.id = p_id AND o.status IN ('sending', 'queued');
END
$$;
REVOKE ALL ON FUNCTION lms.email_mark(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_mark(uuid, text, text, text, text) TO lms_app;

-- ------------------------------------------------------------------ provider webhooks (bounces and complaints)
-- p_events: normalized by the adapter after its signature check: [{id, kind, email, messageId, occurredAt, detail}].
-- An event already seen is skipped (replay). A hard bounce / complaint adds (or upgrades) the active suppression of the address.
CREATE FUNCTION lms.email_webhook_ingest(p_provider text, p_events jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH ev AS (
    SELECT left(e ->> 'id', 300) AS event_id,
           CASE WHEN e ->> 'kind' IN ('bounce', 'complaint', 'delivered', 'deferred', 'dropped') THEN e ->> 'kind' ELSE 'other' END AS kind,
           lower(left(e ->> 'email', 320)) AS email, left(e ->> 'messageId', 300) AS message_id,
           CASE WHEN e ->> 'outboxId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (e ->> 'outboxId')::uuid END AS outbox_id,
           (e ->> 'occurredAt')::timestamptz AS occurred_at, left(e ->> 'detail', 300) AS detail
      FROM jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
     WHERE coalesce(e ->> 'id', '') <> ''),
  fresh AS (
    INSERT INTO lms.email_events (provider, event_id, kind, email, outbox_id, occurred_at)
    SELECT p_provider, ev.event_id, ev.kind, ev.email,
           coalesce((SELECT o.id FROM lms.email_outbox o WHERE o.id = ev.outbox_id),
                    (SELECT o.id FROM lms.email_outbox o WHERE o.provider_message_id = ev.message_id LIMIT 1)),
           ev.occurred_at
      FROM ev
    ON CONFLICT (provider, event_id) DO NOTHING
    RETURNING event_id, kind, email, outbox_id),
  sup AS (
    SELECT DISTINCT ON (f.email) f.email, f.kind, ev.detail, (SELECT o.tenant_id FROM lms.email_outbox o WHERE o.id = f.outbox_id) AS tenant_id
      FROM fresh f JOIN ev ON ev.event_id = f.event_id
     WHERE f.kind IN ('bounce', 'complaint') AND f.email ~ '@'
     ORDER BY f.email, (f.kind = 'bounce') DESC),
  ins AS (
    INSERT INTO lms.email_suppressions (id, email, reason, detail, provider, source_tenant_id)
    SELECT lms.uuid_v7(), s.email, s.kind, s.detail, p_provider, s.tenant_id FROM sup s
    ON CONFLICT (email) WHERE cleared_at IS NULL
    DO UPDATE SET reason = CASE WHEN EXCLUDED.reason = 'bounce' THEN 'bounce' ELSE lms.email_suppressions.reason END,
                  detail = coalesce(EXCLUDED.detail, lms.email_suppressions.detail)
    RETURNING 1)
  SELECT count(*) INTO n FROM fresh;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.email_webhook_ingest(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_webhook_ingest(text, jsonb) TO lms_app;

-- ------------------------------------------------------------------ suppressions: the member's own state (the banner)
CREATE FUNCTION lms.email_suppression_status(p_user uuid)
RETURNS TABLE (email text, reason text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT s.email, s.reason, s.created_at
    FROM lms.users u JOIN lms.email_suppressions s ON s.email = u.email AND s.cleared_at IS NULL
   WHERE u.id = p_user
$$;
REVOKE ALL ON FUNCTION lms.email_suppression_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_suppression_status(uuid) TO lms_app;

-- An institution admin sees (and clears) the active suppressions of THEIR college's members only. The caller (the service) has
-- checked email.suppression.manage; the function itself restricts to addresses of members of p_tenant.
CREATE FUNCTION lms.email_suppressions_for_tenant(p_tenant uuid, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, email text, reason text, detail text, created_at timestamptz, user_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT s.id, s.email, s.reason, s.detail, s.created_at, u.id, u.display_name
    FROM lms.email_suppressions s
    JOIN lms.users u ON u.email = s.email
    JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.user_id = u.id AND m.status <> 'removed'
   WHERE s.cleared_at IS NULL AND (p_after IS NULL OR s.id < p_after)
   ORDER BY s.id DESC
   LIMIT least(greatest(p_limit, 1), 101)
$$;
REVOKE ALL ON FUNCTION lms.email_suppressions_for_tenant(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_suppressions_for_tenant(uuid, uuid, integer) TO lms_app;

-- Returns 'ok' or 'not_found' (not active, or not an address of this college's members). Audited in the college's log.
CREATE FUNCTION lms.email_suppression_clear_tenant(p_tenant uuid, p_actor uuid, p_id uuid, p_audit_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  s lms.email_suppressions%ROWTYPE;
  v_user uuid;
BEGIN
  SELECT x.* INTO s FROM lms.email_suppressions x WHERE x.id = p_id AND x.cleared_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT u.id INTO v_user FROM lms.users u
    JOIN lms.tenant_memberships m ON m.tenant_id = p_tenant AND m.user_id = u.id AND m.status <> 'removed'
   WHERE u.email = s.email;
  IF v_user IS NULL THEN RETURN 'not_found'; END IF;
  UPDATE lms.email_suppressions SET cleared_at = now(), cleared_by = p_actor, cleared_in_tenant = p_tenant WHERE id = p_id;
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_audit_id, p_tenant, p_actor, 'email.suppression_cleared', 'user', v_user::text,
          jsonb_build_object('reason', s.reason, 'suppressedAt', s.created_at));
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION lms.email_suppression_clear_tenant(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_suppression_clear_tenant(uuid, uuid, uuid, uuid) TO lms_app;

-- Platform admins: every active suppression, clear any, set a college's verified From address. Each re-checks the actor.
CREATE FUNCTION lms.platform_email_suppressions(p_actor uuid, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, email text, reason text, detail text, provider text, created_at timestamptz, source_tenant_slug text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s.id, s.email, s.reason, s.detail, s.provider, s.created_at, t.slug
      FROM lms.email_suppressions s LEFT JOIN lms.tenants t ON t.id = s.source_tenant_id
     WHERE s.cleared_at IS NULL AND (p_after IS NULL OR s.id < p_after)
     ORDER BY s.id DESC
     LIMIT least(greatest(p_limit, 1), 101);
END
$$;
REVOKE ALL ON FUNCTION lms.platform_email_suppressions(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_email_suppressions(uuid, uuid, integer) TO lms_app;

CREATE FUNCTION lms.platform_email_suppression_clear(p_actor uuid, p_id uuid, p_audit_id uuid, p_ip inet)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  s lms.email_suppressions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  SELECT x.* INTO s FROM lms.email_suppressions x WHERE x.id = p_id AND x.cleared_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  UPDATE lms.email_suppressions SET cleared_at = now(), cleared_by = p_actor WHERE id = p_id;
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, 'email.suppression_cleared', 'email_suppression', p_id::text,
          jsonb_build_object('reason', s.reason, 'suppressedAt', s.created_at), p_ip);
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION lms.platform_email_suppression_clear(uuid, uuid, uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_email_suppression_clear(uuid, uuid, uuid, inet) TO lms_app;

CREATE FUNCTION lms.platform_set_email_sender(p_actor uuid, p_tenant uuid, p_from text, p_audit_id uuid, p_ip inet)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_before text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  SELECT t.email_from INTO v_before FROM lms.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  UPDATE lms.tenants SET email_from = lower(p_from), updated_at = now() WHERE id = p_tenant;
  INSERT INTO lms.platform_audit_log (id, actor_user_id, action, target_type, target_id, metadata, ip)
  VALUES (p_audit_id, p_actor, 'platform.tenant_email_sender_set', 'tenant', p_tenant::text,
          jsonb_build_object('before', v_before, 'after', lower(p_from)), p_ip);
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION lms.platform_set_email_sender(uuid, uuid, text, uuid, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_set_email_sender(uuid, uuid, text, uuid, inet) TO lms_app;

-- ------------------------------------------------------------------ the bell (2 round trips: session lookup + this call)
-- Unread count capped at 100 (an index-only scan of the partial index), plus the newest unread id for the ETag.
CREATE FUNCTION lms.notify_unread(p_tenant uuid, p_user uuid)
RETURNS TABLE (unread integer, newest uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT (SELECT count(*)::int FROM (SELECT 1 FROM lms.notifications n
                                       WHERE n.tenant_id = p_tenant AND n.user_id = p_user AND n.read_at IS NULL
                                       LIMIT 100) c),
         (SELECT n.id FROM lms.notifications n
           WHERE n.tenant_id = p_tenant AND n.user_id = p_user AND n.read_at IS NULL
           ORDER BY n.id DESC LIMIT 1)
$$;
REVOKE ALL ON FUNCTION lms.notify_unread(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_unread(uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ unsubscribe (the token was verified by the API)
-- Turns EMAIL off for one category of one member (in-app is kept). Security mail cannot be unsubscribed. Audited.
-- Returns 'ok', 'mandatory' or 'not_member'.
CREATE FUNCTION lms.notify_unsubscribe(p_tenant uuid, p_user uuid, p_category text, p_audit_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  v_app boolean;
BEGIN
  IF p_category = 'security'
     OR p_category NOT IN ('learning_deadlines', 'learning_grades', 'learning_content', 'teaching_grading',
                           'teaching_updates', 'admin') THEN
    RETURN 'mandatory';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user
                   AND m.status <> 'removed') THEN
    RETURN 'not_member';
  END IF;
  v_app := coalesce((SELECT p.in_app FROM lms.notification_preferences p
                      WHERE p.tenant_id = p_tenant AND p.user_id = p_user AND p.category = p_category),
                    (lms.notify_settings(p_tenant) -> 'defaults' -> p_category ->> 'inApp')::boolean, true);
  INSERT INTO lms.notification_preferences (tenant_id, user_id, category, email, in_app)
  VALUES (p_tenant, p_user, p_category, false, v_app)
  ON CONFLICT (tenant_id, user_id, category) DO UPDATE SET email = false, updated_at = now();
  INSERT INTO lms.audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_audit_id, p_tenant, p_user, 'notification.unsubscribed', 'user', p_user::text,
          jsonb_build_object('category', p_category));
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION lms.notify_unsubscribe(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_unsubscribe(uuid, uuid, text, uuid) TO lms_app;

-- What the unsubscribe page shows before the member confirms: the college, the masked address, the current email setting.
CREATE FUNCTION lms.notify_unsubscribe_info(p_tenant uuid, p_user uuid, p_category text)
RETURNS TABLE (college text, email_masked text, subscribed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  SELECT coalesce(b.value ->> 'displayName', t.name),
         left(split_part(u.email, '@', 1), 2) || '***@' || split_part(u.email, '@', 2),
         coalesce(p.email, (lms.notify_settings(p_tenant) -> 'defaults' -> p_category ->> 'email')::boolean, true)
    FROM lms.tenant_memberships m
    JOIN lms.tenants t ON t.id = m.tenant_id
    JOIN lms.users u ON u.id = m.user_id
    LEFT JOIN lms.tenant_settings b ON b.tenant_id = t.id AND b.key = 'branding'
    LEFT JOIN lms.notification_preferences p ON p.tenant_id = m.tenant_id AND p.user_id = m.user_id AND p.category = p_category
   WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.status <> 'removed'
$$;
REVOKE ALL ON FUNCTION lms.notify_unsubscribe_info(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_unsubscribe_info(uuid, uuid, text) TO lms_app;

-- ------------------------------------------------------------------ platform admins' inbox
CREATE FUNCTION lms.platform_notifications_page(p_actor uuid, p_after uuid, p_limit integer, p_unread_only boolean)
RETURNS TABLE (id uuid, type text, params jsonb, link text, created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT n.id, n.type, n.params, n.link, n.created_at, n.read_at FROM lms.platform_notifications n
     WHERE n.user_id = p_actor AND (p_after IS NULL OR n.id < p_after) AND (NOT p_unread_only OR n.read_at IS NULL)
     ORDER BY n.id DESC LIMIT least(greatest(p_limit, 1), 101);
END
$$;
REVOKE ALL ON FUNCTION lms.platform_notifications_page(uuid, uuid, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_notifications_page(uuid, uuid, integer, boolean) TO lms_app;

CREATE FUNCTION lms.platform_notifications_unread(p_actor uuid)
RETURNS TABLE (unread integer, newest uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT (SELECT count(*)::int FROM (SELECT 1 FROM lms.platform_notifications n
                                         WHERE n.user_id = p_actor AND n.read_at IS NULL LIMIT 100) c),
           (SELECT n.id FROM lms.platform_notifications n WHERE n.user_id = p_actor AND n.read_at IS NULL
             ORDER BY n.id DESC LIMIT 1);
END
$$;
REVOKE ALL ON FUNCTION lms.platform_notifications_unread(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_notifications_unread(uuid) TO lms_app;

-- p_id NULL = mark all read. Returns the number of rows changed.
CREATE FUNCTION lms.platform_notifications_read(p_actor uuid, p_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lms.users u WHERE u.id = p_actor AND u.is_platform_admin) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  UPDATE lms.platform_notifications SET read_at = now()
   WHERE user_id = p_actor AND read_at IS NULL AND (p_id IS NULL OR id = p_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION lms.platform_notifications_read(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.platform_notifications_read(uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ retention (worker; bounded batches)
-- read notifications older than p_days; at most p_batch rows (clamped to 10,000) per call: the caller loops on a full batch
CREATE FUNCTION lms.notify_purge_read(p_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  DELETE FROM lms.notifications WHERE id IN (
    SELECT id FROM lms.notifications WHERE read_at IS NOT NULL AND read_at < now() - make_interval(days => p_days)
     LIMIT least(greatest(p_batch, 1), 10000));
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM lms.platform_notifications WHERE id IN (
    SELECT id FROM lms.platform_notifications WHERE read_at IS NOT NULL AND read_at < now() - make_interval(days => p_days)
     LIMIT least(greatest(p_batch, 1), 10000));
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END
$$;
REVOKE ALL ON FUNCTION lms.notify_purge_read(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.notify_purge_read(integer, integer) TO lms_app;

-- finished outbox rows (and the provider events) older than p_days; queued / sending rows are never purged
CREATE FUNCTION lms.email_outbox_purge(p_days integer, p_batch integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  DELETE FROM lms.email_outbox WHERE id IN (
    SELECT id FROM lms.email_outbox
     WHERE created_at < now() - make_interval(days => p_days) AND status NOT IN ('queued', 'sending')
     LIMIT least(greatest(p_batch, 1), 10000));
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM lms.email_events WHERE (provider, event_id) IN (
    SELECT provider, event_id FROM lms.email_events WHERE received_at < now() - make_interval(days => p_days)
     LIMIT least(greatest(p_batch, 1), 10000));
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END
$$;
REVOKE ALL ON FUNCTION lms.email_outbox_purge(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.email_outbox_purge(integer, integer) TO lms_app;

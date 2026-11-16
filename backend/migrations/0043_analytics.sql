-- Step 12: dashboards, reports, at-risk learners and usage metering. Part 1: the college time zone, activity tracking, the
-- daily video watch log, the change marks that drive the incremental rollups, and the rollup tables themselves.
-- Rollups are written ONLY by the definer functions of migration 0044 (the worker has no tenant context); `lms_app` reads them.

-- ------------------------------------------------------------------ the college time zone
-- tenant_settings key 'timezone' (a jsonb string, an IANA name); the default is Asia/Kolkata. Every "day", "week" and "month"
-- bucket of this step is a LOCAL day of this zone; timestamps stay UTC.
CREATE FUNCTION lms.tenant_tz(p_tenant uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT coalesce((SELECT s.value #>> '{}' FROM lms.tenant_settings s WHERE s.tenant_id = p_tenant AND s.key = 'timezone'),
                  'Asia/Kolkata')
$$;
REVOKE ALL ON FUNCTION lms.tenant_tz(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.tenant_tz(uuid) TO lms_app;

-- The local calendar day of an instant in a zone. STABLE (the zone database can change), never used in an index.
CREATE FUNCTION lms.local_day(p_ts timestamptz, p_tz text)
RETURNS date LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$ SELECT (p_ts AT TIME ZONE p_tz)::date $$;
REVOKE ALL ON FUNCTION lms.local_day(timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.local_day(timestamptz, text) TO lms_app;

-- The instant the local day AFTER the one of p_ts starts (DST-safe: midnight is converted, not "+24 h").
CREATE FUNCTION lms.next_local_midnight(p_ts timestamptz, p_tz text)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$ SELECT (((p_ts AT TIME ZONE p_tz)::date + 1)::timestamp) AT TIME ZONE p_tz $$;
REVOKE ALL ON FUNCTION lms.next_local_midnight(timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.next_local_midnight(timestamptz, text) TO lms_app;

-- ------------------------------------------------------------------ activity: one row per user and local day
CREATE TABLE lms.member_activity_days (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  user_id uuid NOT NULL REFERENCES lms.users (id) ON DELETE RESTRICT,
  day date NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, day)
);
CREATE INDEX member_activity_days_day_idx ON lms.member_activity_days (tenant_id, day, user_id);

-- ------------------------------------------------------------------ the daily video watch log
-- progress_heartbeat adds the NEW unique seconds it accepted to the row of the learner, the item, the video asset and the local
-- day. This is what "hours watched in a month" is built from (item_progress only keeps the cumulative total).
CREATE TABLE lms.video_watch_days (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  participant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  day date NOT NULL,
  seconds integer NOT NULL CHECK (seconds > 0),
  PRIMARY KEY (tenant_id, participant_id, item_id, asset_id, day),
  CONSTRAINT video_watch_days_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT video_watch_days_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.content_items (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX video_watch_days_day_idx ON lms.video_watch_days (tenant_id, day);
CREATE INDEX video_watch_days_item_idx ON lms.video_watch_days (tenant_id, item_id);

-- ------------------------------------------------------------------ change marks (what the rollups must recompute)
-- A mark says "this learner / this offering changed since the rollup last looked". Triggers write them in the SAME transaction as
-- the change, so a change can never be lost; the refresh deletes only the marks it saw (same marked_at), so a change that lands
-- while it runs stays marked. No grants: only the trigger functions and the refresh functions touch them.
CREATE TABLE lms.rollup_dirty_participants (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  participant_id uuid NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, participant_id)
) WITH (fillfactor = 70);
CREATE TABLE lms.rollup_dirty_offerings (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, offering_id)
) WITH (fillfactor = 70);

-- ------------------------------------------------------------------ the rollups
-- one row per learner (participant) of an offering
CREATE TABLE lms.rollup_learner_offering (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  participant_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  user_id uuid NOT NULL,
  total_required integer NOT NULL,
  completed_required integer NOT NULL,
  -- required visible items open longer than behind_after_days and not done
  behind_items integer NOT NULL,
  -- assignments past their (extended) due date and assessments past their close with nothing handed in / attempted
  missed_deadlines integer NOT NULL,
  -- average of the percent of every RELEASED score (assignments and quizzes); NULL when none is released
  avg_score numeric(5, 2),
  scored_items integer NOT NULL,
  last_activity_at timestamptz,
  enrolled_at timestamptz NOT NULL,
  video_seconds integer NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, participant_id),
  CONSTRAINT rollup_learner_offering_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX rollup_learner_offering_offering_idx ON lms.rollup_learner_offering (tenant_id, offering_id);
CREATE INDEX rollup_learner_offering_user_idx ON lms.rollup_learner_offering (tenant_id, user_id);

-- per offering and local day: what happened that day (active = any learner event of that day)
CREATE TABLE lms.rollup_offering_day (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  day date NOT NULL,
  active_learners integer NOT NULL,
  items_completed integer NOT NULL,
  submissions integer NOT NULL,
  attempts integer NOT NULL,
  video_seconds integer NOT NULL,
  PRIMARY KEY (tenant_id, offering_id, day),
  CONSTRAINT rollup_offering_day_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX rollup_offering_day_day_idx ON lms.rollup_offering_day (tenant_id, day);

-- per department / program / batch / section and local day: the members active that day (a day keeps the group the member
-- belonged to when it was rolled up: history is not rewritten when a student changes section)
CREATE TABLE lms.rollup_org_day (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  scope text NOT NULL CHECK (scope IN ('department', 'program', 'batch', 'section')),
  scope_id uuid NOT NULL,
  day date NOT NULL,
  active_members integer NOT NULL,
  PRIMARY KEY (tenant_id, scope, scope_id, day)
);
CREATE INDEX rollup_org_day_day_idx ON lms.rollup_org_day (tenant_id, day);

-- per local day for the whole college
CREATE TABLE lms.rollup_tenant_day (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  day date NOT NULL,
  active_users integer NOT NULL,
  active_learners integer NOT NULL,
  video_seconds bigint NOT NULL,
  -- the storage gauge measured when the day's row was last computed (files + video outputs + video sources)
  storage_bytes bigint NOT NULL,
  PRIMARY KEY (tenant_id, day)
);

-- when each rollup was last brought up to date ("data as of"); as_of = the oldest change not yet applied, else the run time
CREATE TABLE lms.rollup_state (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  kind text NOT NULL CHECK (kind IN ('learner', 'offering_day', 'org_day', 'tenant_day')),
  watermark timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  rows_written integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind)
);

-- monthly usage snapshots, immutable (a correction is a new revision with a reason)
CREATE TABLE lms.usage_snapshots (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  month date NOT NULL CHECK (date_trunc('month', month) = month),
  revision smallint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  time_zone text NOT NULL,
  billable_learners integer NOT NULL,
  active_users integer NOT NULL,
  video_seconds bigint NOT NULL,
  video_gb_estimate numeric(14, 3) NOT NULL,
  storage_bytes bigint NOT NULL,
  offerings integer NOT NULL,
  active_offerings integer NOT NULL,
  definition jsonb NOT NULL,
  rendition_mix jsonb NOT NULL,
  reason text CHECK (length(reason) <= 500),
  closed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month, revision),
  CONSTRAINT usage_snapshots_reason_ck CHECK ((revision = 1) = (reason IS NULL))
);
CREATE FUNCTION lms.analytics_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lms.% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION lms.analytics_immutable() FROM PUBLIC;
CREATE TRIGGER usage_snapshots_immutable BEFORE UPDATE OR DELETE ON lms.usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION lms.analytics_immutable();

-- ------------------------------------------------------------------ RLS and grants
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_activity_days', 'video_watch_days', 'rollup_dirty_participants', 'rollup_dirty_offerings',
    'rollup_learner_offering', 'rollup_offering_day', 'rollup_org_day', 'rollup_tenant_day', 'rollup_state', 'usage_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON lms.%I FOR ALL TO lms_app USING (tenant_id = (SELECT lms.current_tenant_id())) '
                   'WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))', t || '_all', t);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;
-- reads only: every write is a definer function. The dirty marks have no grant at all.
GRANT SELECT ON lms.member_activity_days, lms.video_watch_days, lms.rollup_learner_offering, lms.rollup_offering_day,
  lms.rollup_org_day, lms.rollup_tenant_day, lms.rollup_state, lms.usage_snapshots TO lms_app;

-- ------------------------------------------------------------------ activity: ONE write per user and local day
-- Returns the instant the next local day starts: the caller remembers "recorded" until then and does not call again.
CREATE FUNCTION lms.activity_touch(p_tenant uuid, p_user uuid, p_now timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  tz text := lms.tenant_tz(p_tenant);
BEGIN
  INSERT INTO lms.member_activity_days (tenant_id, user_id, day, first_at)
  VALUES (p_tenant, p_user, lms.local_day(p_now, tz), p_now)
  ON CONFLICT (tenant_id, user_id, day) DO NOTHING;
  RETURN lms.next_local_midnight(p_now, tz);
END
$$;
REVOKE ALL ON FUNCTION lms.activity_touch(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.activity_touch(uuid, uuid, timestamptz) TO lms_app;

-- ------------------------------------------------------------------ the change-mark triggers
CREATE FUNCTION lms.rollup_mark_participant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id) VALUES (NEW.tenant_id, NEW.participant_id)
  ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp();
  RETURN NULL;
END
$$;
-- course_participants: the row's own id is the participant
CREATE FUNCTION lms.rollup_mark_participant_self()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  INSERT INTO lms.rollup_dirty_participants (tenant_id, participant_id) VALUES (NEW.tenant_id, NEW.id)
  ON CONFLICT (tenant_id, participant_id) DO UPDATE SET marked_at = clock_timestamp();
  RETURN NULL;
END
$$;
-- offering-wide changes (items, modules, deadlines, settings): ONE row, expanded to the learners by the refresh
CREATE FUNCTION lms.rollup_mark_offering()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  o uuid;
  t uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN t := OLD.tenant_id; ELSE t := NEW.tenant_id; END IF;
  IF TG_TABLE_NAME = 'course_offerings' THEN
    o := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    o := CASE WHEN TG_OP = 'DELETE' THEN OLD.offering_id ELSE NEW.offering_id END;
  END IF;
  INSERT INTO lms.rollup_dirty_offerings (tenant_id, offering_id) VALUES (t, o)
  ON CONFLICT (tenant_id, offering_id) DO UPDATE SET marked_at = clock_timestamp();
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.rollup_mark_participant() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.rollup_mark_participant_self() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.rollup_mark_offering() FROM PUBLIC;

CREATE TRIGGER item_progress_rollup AFTER INSERT OR UPDATE ON lms.item_progress
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER submissions_rollup AFTER INSERT ON lms.submissions
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER assignment_grades_rollup AFTER INSERT OR UPDATE ON lms.assignment_grades
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER attempts_rollup AFTER INSERT OR UPDATE ON lms.attempts
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER assignment_extensions_rollup AFTER INSERT OR UPDATE ON lms.assignment_extensions
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER video_watch_days_rollup AFTER INSERT OR UPDATE ON lms.video_watch_days
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant();
CREATE TRIGGER course_participants_rollup AFTER INSERT OR UPDATE ON lms.course_participants
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_participant_self();
CREATE TRIGGER content_items_rollup AFTER INSERT OR UPDATE OR DELETE ON lms.content_items
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_offering();
CREATE TRIGGER content_modules_rollup AFTER INSERT OR UPDATE OR DELETE ON lms.content_modules
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_offering();
CREATE TRIGGER assignments_rollup AFTER INSERT OR UPDATE OR DELETE ON lms.assignments
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_offering();
CREATE TRIGGER assessments_rollup AFTER INSERT OR UPDATE OR DELETE ON lms.assessments
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_offering();
CREATE TRIGGER course_offerings_rollup AFTER INSERT OR UPDATE ON lms.course_offerings
  FOR EACH ROW EXECUTE FUNCTION lms.rollup_mark_offering();

-- ------------------------------------------------------------------ the heartbeat also records the day's new seconds
-- Same function as migration 0026 plus ONE upsert into video_watch_days when new seconds were accepted (still one call).
CREATE OR REPLACE FUNCTION lms.progress_heartbeat(
  p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_video uuid, p_stream uuid, p_seq integer,
  p_ranges text, p_position integer, p_rate numeric)
RETURNS TABLE (result text, watched_seconds integer, duration_s integer, percent integer, completed boolean,
               position_s integer, clamped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  a record;
  r lms.item_progress%ROWTYPE;
  dur integer;
  claim int4multirange;
  fresh int4multirange;
  kept int4multirange;
  merged int4multirange;
  avail real;
  new_secs integer;
  gained integer;
  was_clamped boolean := false;
  n_ranges integer;
  watched integer;
  done boolean;
BEGIN
  SELECT * INTO a FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF a.verdict <> 'ok' THEN RETURN QUERY SELECT a.verdict, 0, 0, 0, false, 0, false; RETURN; END IF;
  IF a.kind <> 'video' OR a.completion <> 'watch' OR a.duration_ms IS NULL THEN
    RETURN QUERY SELECT 'not_video', 0, 0, 0, false, 0, false; RETURN;
  END IF;
  IF a.video_asset_id IS DISTINCT FROM p_video THEN
    RETURN QUERY SELECT 'video_changed', 0, 0, 0, false, 0, false; RETURN;
  END IF;
  dur := greatest(1, a.duration_ms / 1000);

  INSERT INTO lms.item_progress (tenant_id, participant_id, item_id, offering_id)
  VALUES (p_tenant, a.participant_id, p_item, a.offering_id)
  ON CONFLICT (tenant_id, participant_id, item_id) DO NOTHING;
  SELECT * INTO r FROM lms.item_progress
   WHERE tenant_id = p_tenant AND participant_id = a.participant_id AND item_id = p_item
   FOR UPDATE;

  r.duration_s := dur;
  IF r.position_stream = p_stream AND p_seq <= r.last_seq THEN
    RETURN QUERY SELECT 'duplicate', r.watched_seconds, dur,
      least(100, (r.watched_seconds * 100) / dur), r.status = 'completed', r.position_s, false;
    RETURN;
  END IF;

  claim := p_ranges::int4multirange * int4multirange(int4range(0, dur, '[)'));
  fresh := claim - r.ranges;
  SELECT coalesce(sum(upper(x) - lower(x)), 0) INTO new_secs FROM unnest(fresh) x;
  avail := least(600::real, r.budget_s + 2 * extract(epoch FROM now() - r.budget_at)::real);
  IF new_secs > avail THEN
    SELECT coalesce(range_agg(int4range(q.lo, q.lo + q.keep::integer)), '{}'::int4multirange) INTO kept
      FROM (
        SELECT lo, least(len, greatest(0, floor(avail)::integer - before)) AS keep
          FROM (SELECT lower(x) AS lo, upper(x) - lower(x) AS len,
                       sum(upper(x) - lower(x)) OVER (ORDER BY lower(x)) - (upper(x) - lower(x)) AS before
                  FROM unnest(fresh) x) s) q
     WHERE q.keep > 0;
    fresh := kept;
    was_clamped := true;
    SELECT coalesce(sum(upper(x) - lower(x)), 0) INTO new_secs FROM unnest(fresh) x;
  END IF;
  merged := r.ranges + fresh;
  SELECT count(*) INTO n_ranges FROM unnest(merged);
  IF n_ranges > 500 THEN
    merged := r.ranges;
    new_secs := 0;
    was_clamped := true;
  END IF;
  merged := merged * int4multirange(int4range(0, dur, '[)'));
  SELECT coalesce(sum(upper(x) - lower(x)), 0) INTO watched FROM unnest(merged) x;
  -- the seconds that really became new (the video may have been replaced by a shorter one)
  gained := greatest(0, watched - r.watched_seconds);

  done := r.status = 'completed' OR watched * 100 >= a.threshold * dur;

  UPDATE lms.item_progress ip SET
    ranges = merged,
    watched_seconds = watched,
    duration_s = dur,
    budget_s = greatest(0, avail - new_secs),
    budget_at = now(),
    suspicious = ip.suspicious + CASE WHEN was_clamped THEN 1 ELSE 0 END,
    status = CASE WHEN done THEN 'completed' ELSE ip.status END,
    completed_at = CASE WHEN done AND ip.completed_at IS NULL THEN now() ELSE ip.completed_at END,
    completed_how = CASE WHEN done AND ip.completed_how IS NULL THEN 'threshold' ELSE ip.completed_how END,
    position_s = CASE WHEN ip.position_stream IS DISTINCT FROM p_stream OR p_seq > ip.last_seq
                      THEN least(greatest(p_position, 0), dur) ELSE ip.position_s END,
    position_stream = p_stream,
    last_seq = p_seq,
    rate = least(greatest(p_rate, 0.25), 4),
    last_activity_at = now()
   WHERE ip.tenant_id = p_tenant AND ip.participant_id = a.participant_id AND ip.item_id = p_item
  RETURNING ip.position_s INTO position_s;

  IF gained > 0 THEN
    INSERT INTO lms.video_watch_days (tenant_id, participant_id, item_id, asset_id, day, seconds)
    VALUES (p_tenant, a.participant_id, p_item, p_video, lms.local_day(now(), lms.tenant_tz(p_tenant)), gained)
    ON CONFLICT (tenant_id, participant_id, item_id, asset_id, day)
      DO UPDATE SET seconds = lms.video_watch_days.seconds + EXCLUDED.seconds;
  END IF;

  RETURN QUERY SELECT 'ok', watched, dur, least(100, (watched * 100) / dur), done, position_s, was_clamped;
END
$$;

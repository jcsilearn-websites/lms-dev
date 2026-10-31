-- Step 8: learning progress. What a learner has done in an offering: unique seconds watched of a video (a
-- multirange of whole seconds), items opened or marked done, per participation. History is never deleted:
-- item_progress points at the participation, the offering and the ITEM with ON DELETE RESTRICT, so an item that has
-- progress is archived (deleted_at), not deleted, and a removed learner keeps their rows.

-- ------------------------------------------------------------------ items: required / completion rule / archive
ALTER TABLE lms.content_items
  ADD COLUMN required boolean NOT NULL DEFAULT true,
  ADD COLUMN completion text,
  -- archived items vanish from outlines, percentages and the builder but keep their progress history
  ADD COLUMN deleted_at timestamptz;
UPDATE lms.content_items SET completion = CASE kind WHEN 'text' THEN 'manual' WHEN 'video' THEN 'watch' ELSE 'on_view' END;
ALTER TABLE lms.content_items ALTER COLUMN completion SET NOT NULL;
-- the default depends on the kind (text: by hand, file / link: when opened, video: by watching): decided here, so every
-- way of inserting an item (the API, a copy, a script) gets the same one
CREATE FUNCTION lms.content_item_completion_default()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  NEW.completion := CASE NEW.kind WHEN 'text' THEN 'manual' WHEN 'video' THEN 'watch' ELSE 'on_view' END;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.content_item_completion_default() FROM PUBLIC;
CREATE TRIGGER content_items_completion_default BEFORE INSERT ON lms.content_items
  FOR EACH ROW WHEN (NEW.completion IS NULL) EXECUTE FUNCTION lms.content_item_completion_default();
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_completion_ck CHECK (
  completion IN ('manual', 'on_view', 'watch') AND ((kind = 'video') = (completion = 'watch')));
ALTER TABLE lms.content_modules ADD COLUMN deleted_at timestamptz;
GRANT UPDATE (required, completion, deleted_at) ON lms.content_items TO lms_app;
GRANT UPDATE (deleted_at) ON lms.content_modules TO lms_app;

-- ------------------------------------------------------------------ offerings: the two settings
ALTER TABLE lms.course_offerings
  -- unique watched coverage (percent of the video) that completes a video item
  ADD COLUMN completion_threshold smallint NOT NULL DEFAULT 90 CHECK (completion_threshold BETWEEN 50 AND 100),
  -- a learner is "behind" when a required item has been open this many days without being completed
  ADD COLUMN behind_after_days smallint NOT NULL DEFAULT 7 CHECK (behind_after_days BETWEEN 1 AND 60);
GRANT UPDATE (completion_threshold, behind_after_days) ON lms.course_offerings TO lms_app;

-- ------------------------------------------------------------------ item_progress
-- the composite foreign key of the progress rows needs this key (the participation, in its own college)
ALTER TABLE lms.course_participants ADD CONSTRAINT course_participants_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE lms.item_progress (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  participant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  completed_at timestamptz,
  completed_how text CHECK (completed_how IN ('threshold', 'manual', 'view')),
  -- video: the seconds actually played, merged by the database ('{[0,30),[45,60)}': whole seconds, end exclusive)
  ranges int4multirange NOT NULL DEFAULT '{}'::int4multirange,
  watched_seconds integer NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
  duration_s integer CHECK (duration_s > 0),
  position_s integer NOT NULL DEFAULT 0 CHECK (position_s >= 0),
  -- the player instance that wrote the position, and its last heartbeat number
  position_stream uuid,
  last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  rate numeric(4, 2),
  -- seconds of new video this learner may still claim (refills at 2x real time, capped); see progress_heartbeat
  budget_s real NOT NULL DEFAULT 45 CHECK (budget_s >= 0),
  budget_at timestamptz NOT NULL DEFAULT now(),
  -- how many heartbeats claimed more than is physically possible (clamped, never shown as an error)
  suspicious integer NOT NULL DEFAULT 0 CHECK (suspicious >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_progress_pkey PRIMARY KEY (tenant_id, participant_id, item_id),
  CONSTRAINT item_progress_completed_ck CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND completed_how IS NOT NULL)),
  -- history is never deleted: nothing cascades into these rows
  CONSTRAINT item_progress_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT item_progress_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT item_progress_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.content_items (tenant_id, id) ON DELETE RESTRICT
) WITH (fillfactor = 70);
-- an item's progress (archive or delete? the item delete asks) and the class view's per-item reads
CREATE INDEX item_progress_item_idx ON lms.item_progress (tenant_id, item_id);
CREATE INDEX item_progress_offering_idx ON lms.item_progress (tenant_id, offering_id);

ALTER TABLE lms.item_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.item_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY item_progress_all ON lms.item_progress FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.item_progress FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;
-- the application only READS progress; every write is one of the definer functions below
GRANT SELECT ON lms.item_progress TO lms_app;

-- ------------------------------------------------------------------ who may record progress on which item
-- The ONE statement of the rule "an active learner of a published offering who can currently see the item":
-- the same conditions as the outline for a learner (published item, published module, not archived, not locked).
-- progress_heartbeat and progress_mark use it; a parity test compares it with the outline.
CREATE FUNCTION lms.learner_item_access(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid)
RETURNS TABLE (participant_id uuid, offering_id uuid, kind text, completion text, video_asset_id uuid,
               duration_ms integer, threshold smallint)
LANGUAGE sql STABLE SET search_path = lms, pg_temp
AS $$
  SELECT p.id, i.offering_id, i.kind, i.completion, i.video_asset_id, va.duration_ms, o.completion_threshold
    FROM lms.content_items i
    JOIN lms.content_modules m ON m.tenant_id = i.tenant_id AND m.id = i.module_id
    JOIN lms.course_offerings o ON o.tenant_id = i.tenant_id AND o.id = i.offering_id
    JOIN lms.course_participants p ON p.tenant_id = i.tenant_id AND p.offering_id = i.offering_id
                                  AND p.participation = 'learner' AND p.status = 'active'
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
                                  AND tm.user_id = p_user AND tm.status = 'active'
    LEFT JOIN lms.video_assets va ON va.tenant_id = i.tenant_id AND va.id = i.video_asset_id AND va.status = 'ready'
   WHERE i.tenant_id = p_tenant AND i.offering_id = p_offering AND i.id = p_item
     AND i.deleted_at IS NULL AND m.deleted_at IS NULL
     AND i.published AND m.published AND o.status = 'published'
     AND coalesce(greatest(i.available_from, m.available_from), '-infinity'::timestamptz) <= now()
$$;
REVOKE ALL ON FUNCTION lms.learner_item_access(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.learner_item_access(uuid, uuid, uuid, uuid) TO lms_app;

-- The same check with the REASON it failed, so the API can answer like every other offering route without a second
-- round trip: 404 for someone who takes no part ('no_offering'), 403 for a participant who is not a learner
-- ('forbidden': instructors and assistants previewing never create learner progress), 404 for a learner who cannot
-- see this item ('not_visible': hidden, locked, archived, in another offering).
CREATE FUNCTION lms.progress_gate(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid)
RETURNS TABLE (verdict text, participant_id uuid, offering_id uuid, kind text, completion text,
               video_asset_id uuid, duration_ms integer, threshold smallint)
LANGUAGE plpgsql STABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  parts text[];
BEGIN
  RETURN QUERY
    SELECT 'ok', g.participant_id, g.offering_id, g.kind, g.completion, g.video_asset_id, g.duration_ms, g.threshold
      FROM lms.learner_item_access(p_tenant, p_user, p_offering, p_item) g;
  IF FOUND THEN RETURN; END IF;
  SELECT array_agg(DISTINCT p.participation::text) INTO parts
    FROM lms.course_participants p
    JOIN lms.tenant_memberships tm ON tm.tenant_id = p.tenant_id AND tm.id = p.membership_id
    JOIN lms.course_offerings o ON o.tenant_id = p.tenant_id AND o.id = p.offering_id
   WHERE p.tenant_id = p_tenant AND p.offering_id = p_offering AND tm.user_id = p_user
     AND p.status = 'active' AND tm.status = 'active'
     AND (p.participation <> 'learner' OR o.status = 'published');
  RETURN QUERY SELECT
    CASE WHEN parts IS NULL THEN 'no_offering'
         WHEN 'learner' = ANY (parts) THEN 'not_visible'
         ELSE 'forbidden' END,
    NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::integer, NULL::smallint;
END
$$;
REVOKE ALL ON FUNCTION lms.progress_gate(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.progress_gate(uuid, uuid, uuid, uuid) TO lms_app;

-- ------------------------------------------------------------------ the heartbeat (ONE call = ONE round trip)
-- p_ranges: the whole seconds played since the last heartbeat as a multirange literal ('{[10,40)}'), already
-- validated by the application (at most 16 ranges, integers). Returns what the player needs to show.
-- result: 'ok' | 'duplicate' (this stream already sent this number) | 'no_offering' | 'forbidden' | 'not_visible' |
-- 'not_video' | 'video_changed'.
--
-- Integrity (never trust the client):
--  * ranges are cut to [0, duration);
--  * a duplicate or older heartbeat of the SAME player instance changes nothing;
--  * a token bucket (refills at 2x real time, capped at 10 minutes, starts at 45 s) limits how many NEW seconds can
--    be claimed: the surplus is cut (earliest seconds kept) and counted in `suspicious`. One bucket per learner and
--    item, so two tabs or devices share it and cannot inflate watched time; the bucket also lets the heartbeats
--    that were queued while offline arrive late without being cut;
--  * re-watching adds nothing (the union of ranges), seeking adds nothing (only played ranges are claimed).
CREATE FUNCTION lms.progress_heartbeat(
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

  -- what is claimed, inside the video, and what of it is new
  claim := p_ranges::int4multirange * int4multirange(int4range(0, dur, '[)'));
  fresh := claim - r.ranges;
  SELECT coalesce(sum(upper(x) - lower(x)), 0) INTO new_secs FROM unnest(fresh) x;
  avail := least(600::real, r.budget_s + 2 * extract(epoch FROM now() - r.budget_at)::real);
  IF new_secs > avail THEN
    -- cut the surplus, keep the earliest seconds
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
  IF n_ranges > 500 THEN -- a pathologically fragmented history: keep what we had
    merged := r.ranges;
    new_secs := 0;
    was_clamped := true;
  END IF;
  -- the video may have been replaced by a shorter one: only seconds inside it count
  merged := merged * int4multirange(int4range(0, dur, '[)'));
  SELECT coalesce(sum(upper(x) - lower(x)), 0) INTO watched FROM unnest(merged) x;

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
    -- the position moves forward within one player instance, and to the newest writer across instances
    position_s = CASE WHEN ip.position_stream IS DISTINCT FROM p_stream OR p_seq > ip.last_seq
                      THEN least(greatest(p_position, 0), dur) ELSE ip.position_s END,
    position_stream = p_stream,
    last_seq = p_seq,
    rate = least(greatest(p_rate, 0.25), 4),
    last_activity_at = now()
   WHERE ip.tenant_id = p_tenant AND ip.participant_id = a.participant_id AND ip.item_id = p_item
  RETURNING ip.position_s INTO position_s;

  RETURN QUERY SELECT 'ok', watched, dur, least(100, (watched * 100) / dur), done, position_s, was_clamped;
END
$$;
REVOKE ALL ON FUNCTION lms.progress_heartbeat(uuid, uuid, uuid, uuid, uuid, uuid, integer, text, integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.progress_heartbeat(uuid, uuid, uuid, uuid, uuid, uuid, integer, text, integer, numeric) TO lms_app;

-- ------------------------------------------------------------------ opened / marked done / undone
-- p_action: 'viewed' (counts for an 'on_view' item, otherwise just records that it was opened),
--           'complete' | 'uncomplete' (only for a 'manual' item).
-- result: 'ok' | 'no_offering' | 'forbidden' | 'not_visible' | 'wrong_rule'; status: the item's status afterwards.
CREATE FUNCTION lms.progress_mark(p_tenant uuid, p_user uuid, p_offering uuid, p_item uuid, p_action text)
RETURNS TABLE (result text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
DECLARE
  a record;
  s text;
BEGIN
  IF p_action NOT IN ('viewed', 'complete', 'uncomplete') THEN
    RAISE EXCEPTION 'unknown progress action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO a FROM lms.progress_gate(p_tenant, p_user, p_offering, p_item);
  IF a.verdict <> 'ok' THEN RETURN QUERY SELECT a.verdict, 'not_started'; RETURN; END IF;
  IF p_action <> 'viewed' AND a.completion <> 'manual' THEN
    RETURN QUERY SELECT 'wrong_rule', 'not_started'; RETURN;
  END IF;

  IF p_action = 'uncomplete' THEN
    UPDATE lms.item_progress ip SET status = 'in_progress', completed_at = NULL, completed_how = NULL,
           last_activity_at = now()
     WHERE ip.tenant_id = p_tenant AND ip.participant_id = a.participant_id AND ip.item_id = p_item
       AND ip.status = 'completed'
    RETURNING ip.status INTO s;
    RETURN QUERY SELECT 'ok', coalesce(s, 'in_progress');
    RETURN;
  END IF;

  INSERT INTO lms.item_progress AS ip (tenant_id, participant_id, item_id, offering_id, status, completed_at, completed_how)
  VALUES (p_tenant, a.participant_id, p_item, a.offering_id,
          CASE WHEN p_action = 'complete' OR (p_action = 'viewed' AND a.completion = 'on_view') THEN 'completed' ELSE 'in_progress' END,
          CASE WHEN p_action = 'complete' OR (p_action = 'viewed' AND a.completion = 'on_view') THEN now() END,
          CASE WHEN p_action = 'complete' THEN 'manual' WHEN p_action = 'viewed' AND a.completion = 'on_view' THEN 'view' END)
  ON CONFLICT (tenant_id, participant_id, item_id) DO UPDATE SET
    status = CASE WHEN ip.status = 'completed' THEN 'completed' WHEN EXCLUDED.status = 'completed' THEN 'completed' ELSE ip.status END,
    completed_at = coalesce(ip.completed_at, EXCLUDED.completed_at),
    completed_how = coalesce(ip.completed_how, EXCLUDED.completed_how),
    last_activity_at = now()
  RETURNING ip.status INTO s;
  RETURN QUERY SELECT 'ok', s;
END
$$;
REVOKE ALL ON FUNCTION lms.progress_mark(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.progress_mark(uuid, uuid, uuid, uuid, text) TO lms_app;

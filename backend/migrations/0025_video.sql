-- Step 7: video lessons. A video is an ASSET (metadata + processing state; the bytes live in object storage or at a
-- video provider) that content items of kind 'video' reference. Copying an offering shares the asset, like files.
-- The purge / source-expiry functions need content_items, so they come here too.

CREATE TABLE lms.video_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  -- the offering the video was uploaded in (authorises the upload and processing routes); items of OTHER offerings
  -- may reference it after a copy
  offering_id uuid NOT NULL,
  created_by uuid NOT NULL,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  provider text NOT NULL DEFAULT 'local' CHECK (provider IN ('local', 'gcp', 'bunny')),
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  -- resumable upload: how many bytes of the original are safely stored (the next chunk must start here)
  upload_offset bigint NOT NULL DEFAULT 0 CHECK (upload_offset >= 0 AND upload_offset <= declared_size),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- filled by the probe
  container text CHECK (container IN ('mp4', 'mov', 'mkv', 'webm')),
  duration_ms integer CHECK (duration_ms > 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  has_audio boolean,
  source_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{ "name": "720p", "width": 1280, "height": 720, "videoKbps": 1300, "bytes": 123 }, ...]
  renditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- storage keys (built by the server from two UUIDs, never from user input)
  source_key text CHECK (length(source_key) <= 200),
  hls_prefix text CHECK (length(hls_prefix) <= 200),
  poster_key text CHECK (length(poster_key) <= 200),
  error_code text CHECK (length(error_code) <= 60),
  error_message text CHECK (length(error_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- last upload chunk / processing step: abandoned uploads are purged from here
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  -- the original is deleted at this time (VIDEO_SOURCE_RETENTION_DAYS after a successful transcode)
  source_expires_at timestamptz,
  source_deleted_at timestamptz,
  -- the last time an item stopped referencing the asset (restarts the purge grace period)
  last_unreferenced_at timestamptz,
  CONSTRAINT video_assets_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT video_assets_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT video_assets_ready_ck CHECK (
    status <> 'ready' OR (duration_ms IS NOT NULL AND hls_prefix IS NOT NULL AND ready_at IS NOT NULL)),
  CONSTRAINT video_assets_failed_ck CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX video_assets_offering_idx ON lms.video_assets (tenant_id, offering_id, created_at DESC);
-- the purge scans by age; the source expiry by due time
CREATE INDEX video_assets_purge_idx ON lms.video_assets (last_activity_at, id);
CREATE INDEX video_assets_source_expiry_idx ON lms.video_assets (source_expires_at)
  WHERE source_deleted_at IS NULL AND source_expires_at IS NOT NULL;

-- Up to 5 WebVTT caption tracks per video (one per language); the text itself is an object next to the video.
CREATE TABLE lms.video_captions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  asset_id uuid NOT NULL,
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  label text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 60),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  storage_key text NOT NULL CHECK (length(storage_key) <= 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_captions_language_key UNIQUE (tenant_id, asset_id, language),
  CONSTRAINT video_captions_asset_fk FOREIGN KEY (tenant_id, asset_id)
    REFERENCES lms.video_assets (tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ content items reference an asset
ALTER TABLE lms.content_items ADD COLUMN video_asset_id uuid;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_video_fk
  FOREIGN KEY (tenant_id, video_asset_id) REFERENCES lms.video_assets (tenant_id, id) ON DELETE RESTRICT;
CREATE INDEX content_items_video_idx ON lms.content_items (tenant_id, video_asset_id)
  WHERE video_asset_id IS NOT NULL;
ALTER TABLE lms.content_items DROP CONSTRAINT content_items_kind_ck;
ALTER TABLE lms.content_items ADD CONSTRAINT content_items_kind_ck CHECK (
  CASE kind
    WHEN 'text' THEN body IS NOT NULL AND file_id IS NULL AND url IS NULL AND video_asset_id IS NULL
    WHEN 'file' THEN file_id IS NOT NULL AND body IS NULL AND url IS NULL AND video_asset_id IS NULL
    WHEN 'link' THEN url IS NOT NULL AND body IS NULL AND file_id IS NULL AND video_asset_id IS NULL
    ELSE video_asset_id IS NOT NULL AND body IS NULL AND file_id IS NULL AND url IS NULL
  END);

-- When an item stops referencing a video (deleted, or pointed at another) the asset's grace period restarts.
CREATE OR REPLACE FUNCTION lms.content_file_unref_on_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.files f SET last_unreferenced_at = now()
   WHERE f.id IN (SELECT file_id FROM old_rows WHERE file_id IS NOT NULL);
  UPDATE lms.video_assets v SET last_unreferenced_at = now()
   WHERE v.id IN (SELECT video_asset_id FROM old_rows WHERE video_asset_id IS NOT NULL);
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION lms.content_file_unref_on_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.files f SET last_unreferenced_at = now()
   WHERE f.id IN (SELECT o.file_id FROM old_rows o JOIN new_rows n ON n.id = o.id
                   WHERE o.file_id IS NOT NULL AND n.file_id IS DISTINCT FROM o.file_id);
  UPDATE lms.video_assets v SET last_unreferenced_at = now()
   WHERE v.id IN (SELECT o.video_asset_id FROM old_rows o JOIN new_rows n ON n.id = o.id
                   WHERE o.video_asset_id IS NOT NULL AND n.video_asset_id IS DISTINCT FROM o.video_asset_id);
  RETURN NULL;
END
$$;

-- ------------------------------------------------------------------ RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['video_assets', 'video_captions']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON lms.%I FOR ALL TO lms_app USING (tenant_id = (SELECT lms.current_tenant_id())) '
      || 'WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))', t || '_all', t);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, DELETE ON lms.video_assets, lms.video_captions TO lms_app;
GRANT UPDATE (upload_offset, status, progress, container, duration_ms, width, height, has_audio, source_meta,
              renditions, source_key, hls_prefix, poster_key, error_code, error_message, updated_at,
              last_activity_at, ready_at, source_expires_at, source_deleted_at, last_unreferenced_at)
  ON lms.video_assets TO lms_app;
GRANT UPDATE (label, size_bytes, storage_key, created_by) ON lms.video_captions TO lms_app; -- replacing a language
GRANT UPDATE (video_asset_id) ON lms.content_items TO lms_app;

-- ------------------------------------------------------------------ worker sweeps (no tenant context)
-- Deletes at most p_limit assets that no item references AND whose last activity / last un-reference / completion
-- is older than p_grace (an abandoned upload, a video nobody used). The rows go first; the caller then removes
-- the objects below <tenant>/<asset>. A reference created concurrently makes the foreign key fail this call (retried).
CREATE FUNCTION lms.video_purge(p_grace interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH doomed AS (
    SELECT v.tenant_id, v.id
      FROM lms.video_assets v
     WHERE greatest(v.last_activity_at, coalesce(v.last_unreferenced_at, v.created_at), coalesce(v.ready_at, v.created_at))
             < now() - p_grace
       AND NOT EXISTS (SELECT 1 FROM lms.content_items i WHERE i.tenant_id = v.tenant_id AND i.video_asset_id = v.id)
     ORDER BY v.last_activity_at, v.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE OF v SKIP LOCKED
  )
  DELETE FROM lms.video_assets v USING doomed d
   WHERE v.tenant_id = d.tenant_id AND v.id = d.id
  RETURNING v.tenant_id, v.id
$$;
REVOKE ALL ON FUNCTION lms.video_purge(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.video_purge(interval, integer) TO lms_app;

-- Marks the originals that are past their retention as deleted and returns them; the caller removes the objects.
CREATE FUNCTION lms.video_sources_expire(p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH due AS (
    SELECT v.tenant_id, v.id
      FROM lms.video_assets v
     WHERE v.source_deleted_at IS NULL AND v.source_expires_at IS NOT NULL AND v.source_expires_at <= now()
     ORDER BY v.source_expires_at, v.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE OF v SKIP LOCKED
  )
  UPDATE lms.video_assets v SET source_deleted_at = now(), source_key = NULL, updated_at = now()
    FROM due d
   WHERE v.tenant_id = d.tenant_id AND v.id = d.id
  RETURNING v.tenant_id, v.id
$$;
REVOKE ALL ON FUNCTION lms.video_sources_expire(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.video_sources_expire(integer) TO lms_app;

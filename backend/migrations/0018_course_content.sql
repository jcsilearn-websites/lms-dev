-- Step 6: course content (modules and items of an offering), cheap reordering keys, and the file purge.

-- ------------------------------------------------------------------ fractional ordering keys
-- A key is a string over 0-9A-Za-z (ASCII order = digit order, compared with COLLATE "C") that never ends in
-- '0'. position_between(lo, hi) returns a key strictly between two neighbours (NULL = the end of the list),
-- so moving an entry rewrites ONE row. Keys grow by a character only when neighbours are packed tightly.
CREATE FUNCTION lms.position_midpoint(a text, b text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = lms, pg_temp
AS $$
DECLARE
  digits constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  n int := 0;
  da int;
  db int;
BEGIN
  IF b IS NOT NULL AND a COLLATE "C" >= b COLLATE "C" THEN
    RAISE EXCEPTION 'position_midpoint: % must sort before %', a, b;
  END IF;
  IF right(a, 1) = '0' OR right(b, 1) = '0' THEN
    RAISE EXCEPTION 'position_midpoint: a key cannot end in 0';
  END IF;
  IF b IS NOT NULL THEN
    -- common prefix (a is padded with '0')
    WHILE n < length(b) AND coalesce(nullif(substr(a, n + 1, 1), ''), '0') = substr(b, n + 1, 1) LOOP
      n := n + 1;
    END LOOP;
    IF n > 0 THEN
      RETURN substr(b, 1, n) || lms.position_midpoint(substr(a, n + 1), substr(b, n + 1));
    END IF;
  END IF;
  da := CASE WHEN a = '' THEN 0 ELSE strpos(digits, substr(a, 1, 1)) - 1 END;
  db := CASE WHEN b IS NULL THEN 62 ELSE strpos(digits, substr(b, 1, 1)) - 1 END;
  IF db - da > 1 THEN
    RETURN substr(digits, ((da + db + 1) / 2) + 1, 1);
  END IF;
  IF b IS NOT NULL AND length(b) > 1 THEN
    RETURN substr(b, 1, 1);
  END IF;
  RETURN substr(digits, da + 1, 1) || lms.position_midpoint(substr(a, 2), NULL);
END
$$;

CREATE FUNCTION lms.position_between(lo text, hi text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = lms, pg_temp
AS $$ SELECT lms.position_midpoint(coalesce(lo, ''), hi) $$;

REVOKE ALL ON FUNCTION lms.position_midpoint(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.position_between(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.position_midpoint(text, text) TO lms_app;
GRANT EXECUTE ON FUNCTION lms.position_between(text, text) TO lms_app;

-- ------------------------------------------------------------------ modules
CREATE TABLE lms.content_modules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 200),
  position text COLLATE "C" NOT NULL CHECK (position ~ '^[0-9A-Za-z]*[1-9A-Za-z]$'),
  published boolean NOT NULL DEFAULT false,
  available_from timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_modules_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT content_modules_offering_id_key UNIQUE (tenant_id, offering_id, id),
  CONSTRAINT content_modules_position_key UNIQUE (tenant_id, offering_id, position),
  CONSTRAINT content_modules_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------ items
CREATE TABLE lms.content_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  module_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'file', 'link', 'video')),
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 200),
  position text COLLATE "C" NOT NULL CHECK (position ~ '^[0-9A-Za-z]*[1-9A-Za-z]$'),
  -- rich text: a validated document tree (JSON), never HTML
  body jsonb CHECK (octet_length(body::text) <= 200000),
  file_id uuid,
  url text CHECK (length(url) <= 2000 AND url ~ '^https?://'),
  published boolean NOT NULL DEFAULT false,
  available_from timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_items_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT content_items_position_key UNIQUE (tenant_id, module_id, position),
  CONSTRAINT content_items_kind_ck CHECK (
    CASE kind
      WHEN 'text' THEN body IS NOT NULL AND file_id IS NULL AND url IS NULL
      WHEN 'file' THEN file_id IS NOT NULL AND body IS NULL AND url IS NULL
      WHEN 'link' THEN url IS NOT NULL AND body IS NULL AND file_id IS NULL
      ELSE body IS NULL AND file_id IS NULL AND url IS NULL
    END),
  -- the offering of an item is the offering of its module (composite FK)
  CONSTRAINT content_items_module_fk FOREIGN KEY (tenant_id, offering_id, module_id)
    REFERENCES lms.content_modules (tenant_id, offering_id, id) ON DELETE CASCADE,
  CONSTRAINT content_items_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES lms.files (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX content_items_offering_idx ON lms.content_items (tenant_id, offering_id, module_id, position);
CREATE INDEX content_items_file_idx ON lms.content_items (tenant_id, file_id) WHERE file_id IS NOT NULL;

-- When an item stops referencing a file (deleted, or pointed elsewhere) the file's grace period restarts.
CREATE FUNCTION lms.content_file_unref_on_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.files f SET last_unreferenced_at = now()
   WHERE f.id IN (SELECT file_id FROM old_rows WHERE file_id IS NOT NULL);
  RETURN NULL;
END
$$;
CREATE FUNCTION lms.content_file_unref_on_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.files f SET last_unreferenced_at = now()
   WHERE f.id IN (SELECT o.file_id FROM old_rows o JOIN new_rows n ON n.id = o.id
                   WHERE o.file_id IS NOT NULL AND n.file_id IS DISTINCT FROM o.file_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.content_file_unref_on_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION lms.content_file_unref_on_update() FROM PUBLIC;
CREATE TRIGGER content_items_unref_del AFTER DELETE ON lms.content_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lms.content_file_unref_on_delete();
CREATE TRIGGER content_items_unref_upd AFTER UPDATE ON lms.content_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION lms.content_file_unref_on_update();

-- ------------------------------------------------------------------ RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_modules', 'content_items']
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

GRANT SELECT, INSERT, DELETE ON lms.content_modules, lms.content_items TO lms_app;
GRANT UPDATE (title, position, published, available_from, updated_at) ON lms.content_modules TO lms_app;
GRANT UPDATE (module_id, title, position, body, file_id, url, published, available_from, updated_at)
  ON lms.content_items TO lms_app;

-- ------------------------------------------------------------------ file purge (worker, no tenant context)
-- Deletes at most p_limit files that nothing references AND whose grace period has passed (measured from the
-- later of the upload confirmation and the last time a reference was removed; a never-confirmed upload counts
-- from its creation). The rows go first, in one statement that re-checks the condition; the caller then removes
-- the objects it gets back. A reference created concurrently makes the foreign key fail this call (retried).
CREATE FUNCTION lms.files_purge(p_grace interval, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
  WITH doomed AS (
    SELECT f.tenant_id, f.id
      FROM lms.files f
     WHERE greatest(coalesce(f.confirmed_at, f.created_at), coalesce(f.last_unreferenced_at, f.created_at))
             < now() - p_grace
       AND NOT EXISTS (SELECT 1 FROM lms.content_items i WHERE i.tenant_id = f.tenant_id AND i.file_id = f.id)
     ORDER BY f.created_at, f.id
     LIMIT least(greatest(p_limit, 1), 1000)
     FOR UPDATE OF f SKIP LOCKED
  )
  DELETE FROM lms.files f USING doomed d
   WHERE f.tenant_id = d.tenant_id AND f.id = d.id
  RETURNING f.storage_key
$$;
REVOKE ALL ON FUNCTION lms.files_purge(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.files_purge(interval, integer) TO lms_app;

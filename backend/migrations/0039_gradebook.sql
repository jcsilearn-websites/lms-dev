-- Step 11: the gradebook (tables). The calculation and the workflow are in 0040 (functions).
--
-- One gradebook per offering (made by a trigger on the offering; backfilled below). Structure (categories, items, scale,
-- rounding) is configuration and is editable while the gradebook is `draft` or `returned`. Everything that HAS BEEN APPROVED
-- is history and never changes: `gradebook_versions` + `gradebook_snapshot_rows` are INSERT-only (a trigger refuses UPDATE and
-- DELETE even for the owner), the events are append-only, manual marks keep a history, overrides are revoked, never deleted.
-- Nothing here cascades from a participant or an item: foreign keys into history are ON DELETE RESTRICT.

-- ------------------------------------------------------------------ grade scales (college templates)
CREATE TABLE lms.grade_scales (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  archived_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grade_scales_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT grade_scales_name_key UNIQUE (tenant_id, name)
);

-- A band is a FLOOR: the grade of a final is the band with the highest min_percent not above the final's percent.
-- There is always a band at 0 (checked by the save function), so every final has a grade.
CREATE TABLE lms.grade_scale_bands (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  scale_id uuid NOT NULL,
  min_percent numeric(6, 3) NOT NULL CHECK (min_percent >= 0 AND min_percent <= 100),
  label text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 12),
  grade_points numeric(4, 2) CHECK (grade_points >= 0 AND grade_points <= 99),
  is_pass boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, scale_id, min_percent),
  CONSTRAINT grade_scale_bands_label_key UNIQUE (tenant_id, scale_id, label),
  CONSTRAINT grade_scale_bands_scale_fk FOREIGN KEY (tenant_id, scale_id)
    REFERENCES lms.grade_scales (tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ the gradebook of an offering
CREATE TABLE lms.gradebooks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  offering_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'locked')),
  -- weighted: categories count by their weights; otherwise one pool of points
  weighted boolean NOT NULL DEFAULT false,
  -- the final is scaled to this many marks
  out_of numeric(8, 2) NOT NULL DEFAULT 100 CHECK (out_of > 0),
  round_mode text NOT NULL DEFAULT 'half_up' CHECK (round_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  round_decimals smallint NOT NULL DEFAULT 0 CHECK (round_decimals BETWEEN 0 AND 2),
  scale_id uuid,
  -- the version being worked on; a locked snapshot has this number, an unlock starts the next
  version_no integer NOT NULL DEFAULT 1 CHECK (version_no >= 1),
  -- [{key, header}]: the column layout of exports
  export_layout jsonb,
  submitted_by uuid,
  submitted_at timestamptz,
  review_comment text CHECK (length(review_comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gradebooks_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT gradebooks_offering_key UNIQUE (tenant_id, offering_id),
  CONSTRAINT gradebooks_offering_fk FOREIGN KEY (tenant_id, offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT gradebooks_scale_fk FOREIGN KEY (tenant_id, scale_id)
    REFERENCES lms.grade_scales (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX gradebooks_status_idx ON lms.gradebooks (tenant_id, status, updated_at DESC, id);

CREATE TABLE lms.gradebook_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  weight numeric(6, 3) NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 1000),
  drop_lowest smallint NOT NULL DEFAULT 0 CHECK (drop_lowest BETWEEN 0 AND 20),
  -- exclude: a missing mark is left out until graded. zero_after_due: counts as 0 once the item is overdue / released
  missing_policy text NOT NULL DEFAULT 'exclude' CHECK (missing_policy IN ('exclude', 'zero_after_due')),
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT gradebook_categories_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT gradebook_categories_name_key UNIQUE (tenant_id, gradebook_id, name),
  CONSTRAINT gradebook_categories_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE RESTRICT
);

-- An item is an assessment or an assignment of the offering (source), or a MANUAL column (marks earned outside the LMS).
-- Items are archived, never deleted once they exist: marks, overrides and snapshots point at them.
CREATE TABLE lms.gradebook_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  category_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('assessment', 'assignment', 'manual')),
  content_item_id uuid,
  -- manual items name themselves; an automatic item takes the title of its content item
  title text CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 120),
  -- the maximum the item is worth in this gradebook (an automatic score is scaled: score / max * points)
  points numeric(8, 2) NOT NULL CHECK (points > 0),
  extra_credit boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  -- manual items only
  due_at timestamptz,
  released boolean NOT NULL DEFAULT false,
  assistants_may_enter boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gradebook_items_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT gradebook_items_source_ck CHECK ((source = 'manual') = (content_item_id IS NULL)),
  CONSTRAINT gradebook_items_title_ck CHECK ((source = 'manual') = (title IS NOT NULL)),
  CONSTRAINT gradebook_items_manual_ck CHECK (
    source = 'manual' OR (due_at IS NULL AND NOT released AND NOT assistants_may_enter)),
  CONSTRAINT gradebook_items_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT gradebook_items_category_fk FOREIGN KEY (tenant_id, category_id)
    REFERENCES lms.gradebook_categories (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT gradebook_items_content_fk FOREIGN KEY (tenant_id, content_item_id)
    REFERENCES lms.content_items (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX gradebook_items_content_key ON lms.gradebook_items (tenant_id, gradebook_id, content_item_id)
  WHERE content_item_id IS NOT NULL;
CREATE INDEX gradebook_items_gradebook_idx ON lms.gradebook_items (tenant_id, gradebook_id, position, id);
CREATE INDEX gradebook_items_category_idx ON lms.gradebook_items (tenant_id, category_id);

-- ------------------------------------------------------------------ manual marks (+ history)
-- A cleared cell has no row. `rev` counts changes (the grid sends the value it saw: a stale cell is reported, not overwritten).
CREATE TABLE lms.manual_marks (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  points numeric(8, 2) NOT NULL CHECK (points >= 0),
  rev integer NOT NULL DEFAULT 1,
  entered_by uuid NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, participant_id),
  CONSTRAINT manual_marks_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.gradebook_items (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_marks_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX manual_marks_participant_idx ON lms.manual_marks (tenant_id, participant_id);

CREATE TABLE lms.manual_mark_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  item_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  before_points numeric(8, 2),
  after_points numeric(8, 2),
  source text NOT NULL CHECK (source IN ('grid', 'import')),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manual_mark_history_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.gradebook_items (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_mark_history_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX manual_mark_history_cell_idx ON lms.manual_mark_history (tenant_id, item_id, participant_id, changed_at DESC);

-- ------------------------------------------------------------------ overrides
-- item_id NULL = an override of the FINAL marks. `points` is in the item's points (or in marks out of `out_of` for the final).
CREATE TABLE lms.grade_overrides (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  item_id uuid,
  points numeric(8, 2) NOT NULL CHECK (points >= 0),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT grade_overrides_revoked_ck CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT grade_overrides_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT grade_overrides_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES lms.gradebook_items (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT grade_overrides_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX grade_overrides_item_key ON lms.grade_overrides (tenant_id, participant_id, item_id)
  WHERE revoked_at IS NULL AND item_id IS NOT NULL;
CREATE UNIQUE INDEX grade_overrides_final_key ON lms.grade_overrides (tenant_id, gradebook_id, participant_id)
  WHERE revoked_at IS NULL AND item_id IS NULL;

-- ------------------------------------------------------------------ the approval workflow and the frozen snapshots
CREATE TABLE lms.gradebook_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  version_no integer NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted', 'returned', 'approved', 'unlocked')),
  actor_user_id uuid NOT NULL,
  self_approved boolean NOT NULL DEFAULT false,
  comment text CHECK (length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gradebook_events_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX gradebook_events_idx ON lms.gradebook_events (tenant_id, gradebook_id, created_at DESC, id);

CREATE TABLE lms.gradebook_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  version_no integer NOT NULL,
  -- the structure at the time of the lock: settings, categories, items (with titles), the grade scale and its bands
  config jsonb NOT NULL,
  -- learners left out of the snapshot (removed from the offering or the college), each with the reason
  excluded jsonb NOT NULL DEFAULT '[]',
  learner_count integer NOT NULL,
  submitted_by uuid,
  approved_by uuid NOT NULL,
  self_approved boolean NOT NULL DEFAULT false,
  locked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gradebook_versions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT gradebook_versions_no_key UNIQUE (tenant_id, gradebook_id, version_no),
  CONSTRAINT gradebook_versions_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE lms.gradebook_snapshot_rows (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  version_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  -- who the learner was at the lock (a later rename or removal does not touch the record)
  register_number text,
  display_name text NOT NULL,
  email text,
  section_code text,
  sort_key text COLLATE "C" NOT NULL,
  cells jsonb NOT NULL,
  cats jsonb NOT NULL,
  final_marks numeric(10, 4),
  final_percent numeric(10, 4),
  grade text,
  is_pass boolean,
  overridden boolean NOT NULL DEFAULT false,
  explanation jsonb NOT NULL,
  PRIMARY KEY (tenant_id, version_id, participant_id),
  CONSTRAINT gradebook_snapshot_rows_version_fk FOREIGN KEY (tenant_id, version_id)
    REFERENCES lms.gradebook_versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT gradebook_snapshot_rows_participant_fk FOREIGN KEY (tenant_id, participant_id)
    REFERENCES lms.course_participants (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX gradebook_snapshot_rows_order_idx ON lms.gradebook_snapshot_rows (tenant_id, version_id, sort_key, participant_id);

-- Immutable for EVERYONE (the owner too): a snapshot, an event, a mark history line is never changed or removed.
CREATE FUNCTION lms.gradebook_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lms.% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;
REVOKE ALL ON FUNCTION lms.gradebook_immutable() FROM PUBLIC;
CREATE TRIGGER gradebook_versions_immutable BEFORE UPDATE OR DELETE ON lms.gradebook_versions
  FOR EACH ROW EXECUTE FUNCTION lms.gradebook_immutable();
CREATE TRIGGER gradebook_snapshot_rows_immutable BEFORE UPDATE OR DELETE ON lms.gradebook_snapshot_rows
  FOR EACH ROW EXECUTE FUNCTION lms.gradebook_immutable();
CREATE TRIGGER gradebook_events_immutable BEFORE UPDATE OR DELETE ON lms.gradebook_events
  FOR EACH ROW EXECUTE FUNCTION lms.gradebook_immutable();
CREATE TRIGGER manual_mark_history_immutable BEFORE UPDATE OR DELETE ON lms.manual_mark_history
  FOR EACH ROW EXECUTE FUNCTION lms.gradebook_immutable();

-- ------------------------------------------------------------------ CSV import of marks (ephemeral staging)
CREATE TABLE lms.mark_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  gradebook_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'applied', 'cancelled')),
  row_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mark_imports_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT mark_imports_gradebook_fk FOREIGN KEY (tenant_id, gradebook_id)
    REFERENCES lms.gradebooks (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE lms.mark_import_cells (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  import_id uuid NOT NULL,
  row_no integer NOT NULL,
  cell_no smallint NOT NULL,
  register_number text NOT NULL,
  -- the header of the column as written; resolved to a manual item by its title (NULL = no such column)
  column_name text NOT NULL,
  item_id uuid,
  raw text NOT NULL,
  participant_id uuid,
  points numeric(8, 2),
  error text,
  PRIMARY KEY (tenant_id, import_id, row_no, cell_no),
  CONSTRAINT mark_import_cells_import_fk FOREIGN KEY (tenant_id, import_id)
    REFERENCES lms.mark_imports (tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ one gradebook per offering, made with the offering
CREATE FUNCTION lms.gradebook_make_default()
RETURNS trigger LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE gid uuid := lms.uuid_v7();
BEGIN
  INSERT INTO lms.gradebooks (id, tenant_id, offering_id) VALUES (gid, NEW.tenant_id, NEW.id)
  ON CONFLICT (tenant_id, offering_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO lms.gradebook_categories (id, tenant_id, gradebook_id, name, weight)
    VALUES (lms.uuid_v7(), NEW.tenant_id, gid, 'General', 100);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.gradebook_make_default() FROM PUBLIC;
CREATE TRIGGER course_offerings_gradebook AFTER INSERT ON lms.course_offerings
  FOR EACH ROW EXECUTE FUNCTION lms.gradebook_make_default();

-- the offerings that exist already
WITH o AS (
  SELECT tenant_id, id, lms.uuid_v7() AS gid FROM lms.course_offerings),
g AS (
  INSERT INTO lms.gradebooks (id, tenant_id, offering_id) SELECT gid, tenant_id, id FROM o
  ON CONFLICT (tenant_id, offering_id) DO NOTHING RETURNING id, tenant_id)
INSERT INTO lms.gradebook_categories (id, tenant_id, gradebook_id, name, weight)
SELECT lms.uuid_v7(), tenant_id, id, 'General', 100 FROM g;

-- ------------------------------------------------------------------ RLS and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grade_scales', 'grade_scale_bands', 'gradebooks', 'gradebook_categories', 'gradebook_items',
                           'manual_marks', 'manual_mark_history', 'grade_overrides', 'gradebook_events',
                           'gradebook_versions', 'gradebook_snapshot_rows', 'mark_imports', 'mark_import_cells']
  LOOP
    EXECUTE format('ALTER TABLE lms.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lms.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON lms.%I FOR ALL TO lms_app USING (tenant_id = (SELECT lms.current_tenant_id())) WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()))',
      t || '_all', t);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      EXECUTE format('CREATE POLICY owner_all ON lms.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON lms.grade_scales TO lms_app;
GRANT UPDATE (name, archived_at, updated_at) ON lms.grade_scales TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.grade_scale_bands TO lms_app;
GRANT SELECT, INSERT ON lms.gradebooks TO lms_app;
GRANT UPDATE (status, weighted, out_of, round_mode, round_decimals, scale_id, version_no, export_layout,
              submitted_by, submitted_at, review_comment, updated_at) ON lms.gradebooks TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.gradebook_categories TO lms_app;
GRANT UPDATE (name, weight, drop_lowest, missing_policy, position) ON lms.gradebook_categories TO lms_app;
GRANT SELECT, INSERT ON lms.gradebook_items TO lms_app;
GRANT UPDATE (category_id, title, points, extra_credit, position, due_at, released, assistants_may_enter, archived_at)
  ON lms.gradebook_items TO lms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lms.manual_marks TO lms_app;
GRANT SELECT, INSERT ON lms.manual_mark_history TO lms_app;
GRANT SELECT, INSERT ON lms.grade_overrides TO lms_app;
GRANT UPDATE (revoked_at, revoked_by) ON lms.grade_overrides TO lms_app;
GRANT SELECT, INSERT ON lms.gradebook_events, lms.gradebook_versions, lms.gradebook_snapshot_rows TO lms_app;
GRANT SELECT, INSERT, DELETE ON lms.mark_imports, lms.mark_import_cells TO lms_app;
GRANT UPDATE (status, row_count) ON lms.mark_imports TO lms_app;
GRANT UPDATE (item_id, participant_id, points, error) ON lms.mark_import_cells TO lms_app;

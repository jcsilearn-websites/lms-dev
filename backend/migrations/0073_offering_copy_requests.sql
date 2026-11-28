-- Idempotency of the offering copy (docs/system-design-review.md): one row per accepted copy request, written BY the copy statement.
-- The client's `request_key` is unique per college, so a double-clicked or retried request cannot append the content a second
-- time: a sequential retry finds the row and is answered from it; a simultaneous one fails the unique key, its whole statement
-- is rolled back, and the service reads the row the winner committed. Append-only for the application.
CREATE TABLE lms.offering_copy_requests (
  tenant_id uuid NOT NULL REFERENCES lms.tenants (id),
  request_key uuid NOT NULL,
  target_offering_id uuid NOT NULL,
  source_offering_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES lms.users (id),
  -- what was asked: a key cannot be reused for a different request
  shift_days integer,
  clear_dates boolean NOT NULL,
  -- what was answered
  mode text NOT NULL CHECK (mode IN ('done', 'queued')),
  modules integer NOT NULL,
  items integer NOT NULL,
  assessments integer NOT NULL,
  assignments integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_key),
  CONSTRAINT offering_copy_requests_target_fk FOREIGN KEY (tenant_id, target_offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT offering_copy_requests_source_fk FOREIGN KEY (tenant_id, source_offering_id)
    REFERENCES lms.course_offerings (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX offering_copy_requests_target_idx ON lms.offering_copy_requests (tenant_id, target_offering_id);
CREATE INDEX offering_copy_requests_source_idx ON lms.offering_copy_requests (tenant_id, source_offering_id);

ALTER TABLE lms.offering_copy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.offering_copy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY offering_copy_requests_all ON lms.offering_copy_requests FOR ALL TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT lms.current_tenant_id()));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY owner_all ON lms.offering_copy_requests FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;
GRANT SELECT, INSERT ON lms.offering_copy_requests TO lms_app;

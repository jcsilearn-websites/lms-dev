-- Step 14b-1 (data protection), part 1: the ONE place that decides how a person is shown inside a college.
--
-- Erasure inside a college (built later in 14b-1) pseudonymises a MEMBERSHIP, not the global account: the same person may belong to
-- other colleges, and a college must never change what another college sees. So the override lives next to the membership:
--
--   membership_display_overrides (tenant_id, membership_id, pseudonym)   one row = "this member is shown under this name here"
--   lms.member_identity                                                  the single read path every college-scoped reader uses
--
-- Everything that shows a member's name or e-mail to someone of THAT college reads lms.member_identity (migration 0061 and the
-- repositories); it returns display_name = COALESCE(pseudonym, users.display_name) and e-mail = '' (empty, never NULL: the response contracts say string) for an overridden member, so a
-- reader cannot forget the override: there is no second place that knows about it. Readers that need the REAL value (sign-in, the
-- session, mail delivery to a live address, the platform area) keep reading lms.users and are listed, with the reason, in
-- test/identity-readers.unit.test.ts.
--
-- The view is security_invoker: the caller's row-level security applies to users (a member of the current tenant, or self),
-- tenant_memberships and the override table, so a college sees only its own members through it (tested, including hostile tenant ids).
-- It is a plain join of three tables: the planner inlines it (no function, no SET clause).

CREATE TABLE lms.membership_display_overrides (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  pseudonym text NOT NULL CHECK (length(pseudonym) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  -- history is never cascaded away (CLAUDE.md): a membership with an override cannot be deleted
  CONSTRAINT membership_display_overrides_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES lms.tenant_memberships (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE lms.membership_display_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.membership_display_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_display_overrides_select ON lms.membership_display_overrides FOR SELECT TO lms_app
  USING (tenant_id = (SELECT lms.current_tenant_id()));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    EXECUTE format(
      'CREATE POLICY owner_all ON lms.membership_display_overrides FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
END
$$;

-- the application can only READ overrides; they are written by the (definer) erasure functions of a later migration
GRANT SELECT ON lms.membership_display_overrides TO lms_app;

-- ---------------------------------------------------------------- the single read path
CREATE VIEW lms.member_identity WITH (security_invoker = true) AS
SELECT m.tenant_id,
       m.id AS membership_id,
       m.user_id,
       COALESCE(o.pseudonym, u.display_name) AS display_name,
       CASE WHEN o.membership_id IS NULL THEN u.email ELSE '' END AS email,
       (o.membership_id IS NOT NULL) AS erased
  FROM lms.tenant_memberships m
  JOIN lms.users u ON u.id = m.user_id
  LEFT JOIN lms.membership_display_overrides o ON o.tenant_id = m.tenant_id AND o.membership_id = m.id;

REVOKE ALL ON lms.member_identity FROM PUBLIC;
GRANT SELECT ON lms.member_identity TO lms_app;

-- ---------------------------------------------------------------- tenant-scoped search keys follow the override
-- The keys are trigger-maintained copies of the user's name and e-mail (migration 0008). A rename or an e-mail change of the GLOBAL
-- user (made in another college, or by the person) must not write the real values back into a membership that has an override.
CREATE OR REPLACE FUNCTION lms.user_sync_search_keys()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.tenant_memberships m
     SET search_name = lower(coalesce((SELECT o.pseudonym FROM lms.membership_display_overrides o
                                        WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id), NEW.display_name)),
         search_email = CASE WHEN EXISTS (SELECT 1 FROM lms.membership_display_overrides o
                                           WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id)
                             THEN NULL ELSE NEW.email END
   WHERE m.user_id = NEW.id;
  RETURN NULL;
END
$$;

-- A new override replaces the keys of that membership at once (the erasure writes the override; nothing else has to remember to).
CREATE FUNCTION lms.override_sync_search_keys()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.tenant_memberships m
     SET search_name = lower(NEW.pseudonym), search_email = NULL
   WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.membership_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.override_sync_search_keys() FROM PUBLIC;
CREATE TRIGGER membership_display_overrides_search_keys
  AFTER INSERT OR UPDATE OF pseudonym ON lms.membership_display_overrides
  FOR EACH ROW EXECUTE FUNCTION lms.override_sync_search_keys();

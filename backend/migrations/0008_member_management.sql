-- Step 4: member management support.
--  1. lms_app may now update a membership's status (suspend / reactivate).
--  2. The last-admin invariant lives in the DATABASE: a trigger serialises every change that takes an
--     active institution_admin away from a tenant and refuses the one that would leave none.
--  3. Tenant-scoped member search keys (denormalised, lowercased, trigger-maintained) so a prefix
--     search touches only the tenant's own rows (decision + measurements: docs/benchmarks.md, step 4).
--  4. Slug immutability, and indexes for the new list endpoints.
-- Forward-only; expand step: new nullable columns + trigger + backfill, nothing is dropped or renamed.

GRANT UPDATE (status) ON lms.tenant_memberships TO lms_app;

-- ---------------------------------------------------------------- last-admin invariant
-- Fires when an ACTIVE institution_admin row stops being one (role change, status change, delete).
-- pg_advisory_xact_lock(tenant) serialises those changes per tenant; the count that follows is a new
-- READ COMMITTED snapshot, so the second of two concurrent demotions sees the first one's commit and
-- fails. The table OWNER (migrations, dev-clean, test resets, deleting a whole tenant) is exempt;
-- lms_app is NOT. A brand-new tenant may have no active admin yet (its first invite is pending): the
-- rule guards transitions away from "has an active admin", it cannot be broken by creating a tenant.
CREATE FUNCTION lms.guard_last_admin()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
DECLARE
  v_others integer;
BEGIN
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF OLD.role = 'institution_admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'institution_admin' OR NEW.status <> 'active') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('lms.last_admin:' || OLD.tenant_id::text, 0));
    SELECT count(*) INTO v_others
      FROM lms.tenant_memberships m
     WHERE m.tenant_id = OLD.tenant_id AND m.id <> OLD.id
       AND m.role = 'institution_admin' AND m.status = 'active';
    IF v_others = 0 THEN
      RAISE EXCEPTION 'a tenant must keep at least one active institution admin'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tenant_last_admin';
    END IF;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_last_admin() FROM PUBLIC;

CREATE TRIGGER tenant_memberships_last_admin
  BEFORE UPDATE OF role, status OR DELETE ON lms.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION lms.guard_last_admin();

-- ---------------------------------------------------------------- slug is immutable
CREATE FUNCTION lms.guard_tenant_slug()
RETURNS trigger
LANGUAGE plpgsql SET search_path = lms, pg_temp
AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'a tenant slug cannot be changed' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'tenant_slug_immutable';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.guard_tenant_slug() FROM PUBLIC;
CREATE TRIGGER tenants_slug_immutable BEFORE UPDATE OF slug ON lms.tenants
  FOR EACH ROW EXECUTE FUNCTION lms.guard_tenant_slug();

-- ---------------------------------------------------------------- tenant-scoped member search keys
ALTER TABLE lms.tenant_memberships ADD COLUMN search_name text;
ALTER TABLE lms.tenant_memberships ADD COLUMN search_email text;

-- SECURITY DEFINER: the user row is not yet visible to lms_app when its first membership is inserted
-- (visibility comes from a membership), and a user rename must reach the memberships of every tenant.
CREATE FUNCTION lms.membership_set_search_keys()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  SELECT lower(u.display_name), u.email INTO NEW.search_name, NEW.search_email
    FROM lms.users u WHERE u.id = NEW.user_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION lms.membership_set_search_keys() FROM PUBLIC;
CREATE TRIGGER tenant_memberships_search_keys BEFORE INSERT ON lms.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION lms.membership_set_search_keys();

CREATE FUNCTION lms.user_sync_search_keys()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, pg_temp
AS $$
BEGIN
  UPDATE lms.tenant_memberships m
     SET search_name = lower(NEW.display_name), search_email = NEW.email
   WHERE m.user_id = NEW.id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION lms.user_sync_search_keys() FROM PUBLIC;
CREATE TRIGGER users_sync_search_keys AFTER UPDATE OF display_name, email ON lms.users
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION lms.user_sync_search_keys();

UPDATE lms.tenant_memberships m
   SET search_name = lower(u.display_name), search_email = u.email
  FROM lms.users u WHERE u.id = m.user_id;

-- ---------------------------------------------------------------- indexes (all lead with tenant_id)
-- list without a search term: keyset on id, optionally filtered by role or status
CREATE INDEX tenant_memberships_role_idx ON lms.tenant_memberships (tenant_id, role, id);
CREATE INDEX tenant_memberships_status_idx ON lms.tenant_memberships (tenant_id, status, id);
-- prefix search (LIKE 'abc%') on the tenant's own rows
CREATE INDEX tenant_memberships_search_name_idx
  ON lms.tenant_memberships (tenant_id, search_name text_pattern_ops);
CREATE INDEX tenant_memberships_search_email_idx
  ON lms.tenant_memberships (tenant_id, search_email text_pattern_ops);
-- audit lists: newest first, filtered by action and/or date range
CREATE INDEX audit_log_tenant_action_idx ON lms.audit_log (tenant_id, action, created_at DESC, id DESC);
-- (platform_audit_log (created_at DESC, id DESC) already exists from 0004)
CREATE INDEX platform_audit_log_action_idx ON lms.platform_audit_log (action, created_at DESC, id DESC);
-- platform tenant list: prefix search on name and slug
CREATE INDEX tenants_name_prefix_idx ON lms.tenants (lower(name) text_pattern_ops);
CREATE INDEX tenants_slug_prefix_idx ON lms.tenants (slug text_pattern_ops);

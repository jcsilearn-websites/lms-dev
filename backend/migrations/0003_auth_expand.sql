-- Step 2 (expand): additive changes only; existing rows get safe defaults.

-- Tenants can be suspended; a suspended tenant resolves to 404 and its sessions stop working.
CREATE TYPE lms.tenant_status AS ENUM ('active', 'suspended');
ALTER TABLE lms.tenants ADD COLUMN status lms.tenant_status NOT NULL DEFAULT 'active';

-- Subdomains that must never be tenant slugs (admin.<domain> is the platform admin area).
ALTER TABLE lms.tenants ADD CONSTRAINT tenants_slug_not_reserved
  CHECK (slug NOT IN ('admin', 'www', 'api', 'app', 'auth', 'mail', 'static', 'assets'));

-- Invites create a pending membership that becomes active when the invite is accepted.
-- (The role enum is unchanged: exactly 'institution_admin' | 'member'.)
CREATE TYPE lms.membership_status AS ENUM ('active', 'pending');
ALTER TABLE lms.tenant_memberships
  ADD COLUMN status lms.membership_status NOT NULL DEFAULT 'active';

-- Emails are stored normalized: trimmed and lowercased (lowercase was already enforced).
ALTER TABLE lms.users ADD CONSTRAINT users_email_trimmed CHECK (email = btrim(email));

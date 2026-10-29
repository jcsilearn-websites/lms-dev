# ADR 0008: Own sessions in Postgres, tenant from the Host, SECURITY DEFINER for pre-tenant lookups

Status: accepted

## Context

Step 2 adds sign-in. The product is multi-tenant: a request must be tied to a tenant _before_ the tenant's data
can be read, while RLS (ADR 0002) deliberately shows `lms_app` nothing without a tenant context. Third-party auth
providers were ruled out by the owner; the database must stay portable (local PostgreSQL now, Cloud SQL later).

## Decision

- **Own server-side sessions** in `lms.sessions`. The cookie holds 32 random bytes; the database stores only their
  SHA-256, so a database read does not yield usable sessions. Idle (7 d) and absolute (30 d) limits, `last_seen_at`
  refreshed at most every 5 minutes, revocation on logout / password change / reset / role change / membership removal
  (a composite FK from `(tenant_id, user_id)` to the membership cascades). Platform-admin sessions have `tenant_id`
  NULL and a plain FK to `users`, because the composite FK is not enforced when `tenant_id` is NULL.
- **Tenant from the Host**: `<slug>.<APP_BASE_DOMAIN>`; platform admin on `admin.<APP_BASE_DOMAIN>`. A session is
  valid only on the host it was issued for, and cookies are host-only (no `Domain`), so tenants cannot read each
  other's cookies. Unknown or suspended tenants are 404. Platform admins cannot log into tenant hosts in this step; the
  audited helper for later in-tenant access exists but no endpoint uses it.
- **SECURITY DEFINER functions** for everything that must happen before a tenant context exists or that touches
  tables `lms_app` may not read: tenant by slug, login lookup, failure counting, set password, session lookup,
  token create/consume, invite accept, platform audit. `user_credentials`, `auth_tokens` and `platform_audit_log`
  have RLS forced, no policy and **no grant** for `lms_app`. Functions are owned by the migration role, pin
  `search_path = lms, pg_temp`, qualify every object, revoke `EXECUTE` from PUBLIC and grant it to `lms_app` only,
  and return only the documented columns (tests enforce all of this, including a search_path hijack attempt).
- **Session lookup is one statement**: it joins the user and membership role and checks expiry, revocation, tenant
  match, **active membership and active tenant** in the database, so suspending a tenant ends its sessions on the very
  next request without waiting for the 60 s slug cache.
- **Login hardening**: argon2id (OWASP minimum parameters, PHC string, rehash on login), generic failure for unknown
  email / wrong password / locked / non-member, a verification always runs, failure bookkeeping is deferred so timing
  does not leak existence, bounded hash concurrency (the libuv threadpool is shared with DNS), per-IP and per-email
  rate limits. **Lockout avoids lockout-DoS**: capped at 15 minutes, attempts while locked are not counted, a password
  reset or an admin/platform-admin unlock clears it immediately, and locking is audited.
- **CSRF** for cookie sessions: Origin/Referer must equal the host and `X-Requested-With: lms` is required on every
  state-changing request, with no exemptions.
- Three new entry points on the DB client: `withTenant` (now also sets `app.user_id`), `withUser` (no tenant), and
  `withoutTenant` (autocommit, only useful for the definer functions).

## Consequences

- Every request with a cookie costs one indexed query (remote-DB latency applies in dev).
- The definer functions are a trusted surface: they authorise nothing themselves, so only the `auth` and `sessions`
  services call them and each has tests. Adding one means following the hardening checklist in CLAUDE.md.
- `*.localhost` subdomains are used in local development; production needs a wildcard DNS record and certificate.
- The in-memory rate limiter is per instance; a shared store remains a known gap.

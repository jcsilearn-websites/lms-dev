# ADR 0009: Permission system, DB-enforced last admin, tenant-scoped member search

Status: accepted (step 4)

## Context

Step 2 left temporary role guards. Step 4 adds member and tenant management, which needs real authorization and two
invariants that must hold under concurrency.

## Decisions

1. **Authorization is `core/authz`, not a module.** A typed permission catalog, role maps in code and one pure
   `can(subject, permission, resource?)` (deny by default, zero DB queries for account-level checks). `core/` must not
   import modules, and nothing here needs the database. Course-scoped checks take a participation the caller resolves
   (`CourseParticipationResolver`, implemented by the courses module later).
2. **Every route declares exactly one of permission / authenticated / public**, enforced by an `onRoute` hook at startup
   and installed as the first `onRequest` hook (401/403 before validation). Services re-check resource-level permissions:
   route checks are coarse, services are the source of truth.
3. **The last-active-institution-admin rule is a trigger**, serialised per tenant with `pg_advisory_xact_lock`, so two
   concurrent demotions cannot both succeed. Application code only maps the error. The table owner is exempt
   (maintenance), the application role is not.
4. **Member search is tenant-scoped**: lowercased `search_name` / `search_email` on `tenant_memberships`, maintained by
   triggers, indexed `(tenant_id, key text_pattern_ops)`. Measured against global indexes on `users` with 50,000 users in
   20 tenants (EXPLAIN ANALYZE as the app role, RLS on): the global approach reached p95 64.7 ms, the tenant-scoped one
   17.9 ms in the handicapped experiment schema and 3.4-4.1 ms on the real tables. See docs/benchmarks.md.
5. **Platform operations are SECURITY DEFINER functions** that re-check the actor is a platform admin and write the audit
   entries in the same statement; tenant mutations are single data-modifying-CTE statements to keep four round trips.

## Consequences

- `docs/permissions.md` is generated and checked in CI; a route or permission change must regenerate it.
- Adding course permissions later means implementing the resolver, not changing `can()`.
- A per-membership capability flag (not a new account role) is the planned way to let faculty create courses.

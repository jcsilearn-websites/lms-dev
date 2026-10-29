# ADR 0003: Global identity with per-tenant memberships

Status: accepted

## Context

Faculty and students may belong to more than one college; a platform operator also exists above all colleges.

## Decision

`users` is global (one row per person, `is_platform_admin` flag). `tenant_memberships (tenant_id, user_id, role)`
links a person to each college. `users` and `tenant_memberships` are RLS-protected: a user row is visible only
through a membership in the current tenant or as the current user (`app.user_id`); memberships are visible only
for the current tenant.

## Consequences

- One login across colleges; per-college roles.
- One tenant cannot enumerate another tenant's people (tested).
- Email/subdomain lookups before a tenant is known must use owner-owned `SECURITY DEFINER` functions, never wider RLS.

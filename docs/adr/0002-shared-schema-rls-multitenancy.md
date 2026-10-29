# ADR 0002: Shared schema + Row-Level Security for multi-tenancy

Status: accepted

## Context

Many colleges (tenants), possibly hundreds, with modest data each. A schema- or database-per-tenant model makes
migrations, connection pooling and cross-tenant platform operations expensive.

## Decision

One shared schema (`lms`). Every tenant-owned table has `tenant_id`; Postgres RLS is enabled **and forced** with
policies keyed on the transaction-local setting `app.tenant_id`. The app role `lms_app` is `NOBYPASSRLS`, owns
nothing and has least-privilege grants. `withTenant(tenantId, fn)` is the only way to touch tenant data.
Composite foreign keys carry `tenant_id`, so cross-tenant references cannot exist.

## Consequences

- Isolation is enforced by the database even if application code has a bug (tested: invisibility, no-tenant =
  zero rows, cross-tenant insert/reference rejected, no RLS bypass).
- Every query runs inside a transaction that sets the tenant (one extra round trip; acceptable).
- Pre-tenant lookups (login by email, tenant by subdomain) need narrow `SECURITY DEFINER` functions (step 2).
- Noisy-neighbour risk is shared-resource risk; mitigated by indexes leading with `tenant_id`, pagination and timeouts.

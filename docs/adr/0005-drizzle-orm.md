# ADR 0005: Drizzle ORM (hand-written SQL migrations)

Status: accepted

## Context

We need typed queries and explicit transactions, but RLS policies, roles, grants, composite FKs and column-level
privileges are central to the design and are not expressible in an ORM schema.

## Decision

Drizzle ORM over the standard `pg` driver for typed queries (`tx` from `withTenant` is a Drizzle transaction).
Migrations are **hand-written, versioned SQL** with our own runner (filename + checksum, advisory lock,
transaction per file). Drizzle table definitions (one `<module>.model.ts` per module) mirror the tables; `schema-drift.test.ts` fails if the live `lms`
schema and the Drizzle definitions disagree (tables, columns, types, nullability, enum values).
Kysely was considered and rejected: no strong reason to deviate from the stated preference; Drizzle's schema
objects give us the drift check and relational helpers we will want later.

## Consequences

- SQL is the source of truth; Drizzle can never silently diverge.
- Two places to edit per schema change (SQL migration + the module's <module>.model.ts) — guarded by the drift test.

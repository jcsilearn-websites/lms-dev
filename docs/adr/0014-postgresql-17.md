# ADR 0014: PostgreSQL 17 everywhere

Status: accepted (Step 6b). Amends [ADR 0011](0011-local-postgres-for-dev-and-tests.md) (which said 18).

## Context

The documents said "PostgreSQL 18 locally, in CI and on Cloud SQL", but the developer machine runs **17.10**, and
everything built so far (all of Step 6 included: migrations, 855 backend tests, E2E, the benchmarks) ran on it. Version 18
was never exercised locally, and a mismatch between what is tested and what is deployed is exactly what a single
required version is meant to prevent.

## Decision

- **PostgreSQL 17 is the required version** locally, in CI (`postgres:17` service container: it follows the 17.x line, minors
  are backward compatible) and for the future Cloud SQL instance, which must be created as PostgreSQL 17.
- The code enforces it: `db/pg-version.ts` (`REQUIRED_PG_MAJOR = 17`) is checked by the migration runner (dev, test
  setup, CI, deploys), by the API and by the worker at startup. Any other major fails with a message naming this ADR.
- No PostgreSQL 18-only feature may be used. The code does not rely on native `uuidv7()`: database-side ids come from
  `lms.uuid_v7()` (migration 0020), a plpgsql implementation of RFC 9562 UUIDv7, so the same code runs on 17 and, later,
  on any newer major. App-side ids keep using the `uuidv7` package.
- Moving to a newer major later is a deliberate step: change `REQUIRED_PG_MAJOR`, CI, Cloud SQL, the docs and re-run the
  suite and benchmarks on it, in one change.

## Consequences

- A developer with another major cannot run migrations or start the API until they install 17.
- Migrations and tests were reviewed for 18-only features (native `uuidv7()`, `RETURNING OLD/NEW`, `WITHOUT OVERLAPS`,
  virtual generated columns, `NOT ENFORCED`): none is used, and the whole suite passes on 17.10.

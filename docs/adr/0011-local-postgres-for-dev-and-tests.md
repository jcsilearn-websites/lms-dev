# ADR 0011: PostgreSQL installed locally for development and tests

Status: accepted (2026-10-29). Supersedes [ADR 0006](0006-supabase-as-plain-postgres-for-dev.md).

## Context

Dev and test ran on two hosted Supabase projects (eu-west-1 and eu-west-3), which are **being deleted** now that nothing uses them. Every statement cost about 200 ms
from the developer machine, so the full suite took about 32 minutes and was exposed to network drops (ENOTFOUND,
ECONNRESET) that were not code failures. The round-trip budgets (CLAUDE.md) kept the application fast, but they
could not make the test run fast, and they hid database-side problems behind latency (see "Consequences").

## Decision

- **PostgreSQL 18 installed natively on the developer machine** (Windows installer, `localhost:5432`), no Docker.
  Same major version as CI and the Cloud SQL target.
- **Dev database** `lms_dev`; **test databases** one per Vitest worker, `lms_test_1 ... lms_test_N`, derived from the
  base name in `TEST_DATABASE_URL` (`lms_test`). They are created and migrated once per run by
  `backend/test/global-setup.ts` and reused; every test file still starts with a TRUNCATE of its worker's database.
  N = CPU cores - 1, `TEST_DB_WORKERS` overrides.
- The cluster needs the roles `anon` and `authenticated` (Supabase ships them; migrations revoke from them).
  `pnpm db:local:setup` creates them and `lms_dev` (it refuses any host but localhost and production). CI creates
  the same roles.
- **Guards**: tests refuse a database NAME equal to the dev database name on any host, production, unsafe names and
  system databases. `DB_SSL=off` is accepted only when every database URL is localhost / 127.0.0.1 and never when
  `NODE_ENV=production`; production needs `DB_SSL=verify-full` + `DB_SSL_CA`.
- **Profiles**: local (10 s per test, parallel) and `REMOTE_DB=1` (one worker, one database, 120 s per test) for a
  slow remote database.
- **Serial project**: files that cannot share the machine run alone after the parallel run: the migration runner
  (the only code that ALTERs the cluster-wide `lms_app` role and takes advisory locks), the SIGTERM process test, the
  wall-clock job / worker tests and the 10,000-row import.
- `lms_app` is a CLUSTER role: one password (`LMS_APP_PASSWORD`) serves the dev database and all test databases.

## Consequences

- A full local run takes minutes instead of about 32 (numbers in `docs/benchmarks.md`).
- Benchmarks now measure the database itself, not the network. This exposed a quadratic statement in the import dry
  run that 200 ms round trips had hidden (fixed in the same change set). Old remote numbers stay in
  `docs/benchmarks.md` under "Supabase eu-west-1 (historical)".
- Local PostgreSQL has no Supabase-style pooler: the dev machine connects directly, so `DB_POOL_MAX` stays small (5)
  because every test worker holds connections against the default limit of 100.
- **Secrets**: a Supabase dev connection string (with its password) was committed in `.env.example` between f4d2fae
  and 0c9a151. Deleting both projects makes it useless; the history is not rewritten. It is the ONLY allowlisted
  value in `.gitleaks.toml`. Secret scanning is now enforced: a gitleaks pre-commit hook (`.githooks/`, enabled by
  `pnpm install`) and a CI job that scans the full history (the default rules missed this string, so
  `.gitleaks.toml` adds a rule for database URLs with a password).
- A hosted Supabase-style server is still tolerated by the code (pooler usernames, `no-verify`) but no longer exercised.

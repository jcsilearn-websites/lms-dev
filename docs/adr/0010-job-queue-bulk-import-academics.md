# ADR 0010: Postgres job queue, set-based bulk import, academic structure in the database

Status: accepted (step 5)

## Context

Step 5 needs background work that survives crashes (bulk CSV import, invite emails, scheduled purges) and a college
structure (years, terms, departments, programs, batches, sections) whose rules must hold under concurrency.

## Decisions

1. **A custom job table, not pg-boss.** pg-boss owns and migrates its own schema at runtime: that conflicts with
   hand-written checksummed migrations, keeps `tenant_id` only inside JSON (no RLS, no composite FKs) and needs DDL rights.
   A `lms.jobs` table claimed with `FOR UPDATE SKIP LOCKED` is ~300 lines, has forced RLS, is covered by the drift and
   policy tests, and a job can be inserted in the business transaction (also set-based, as `INSERT ... SELECT`). It polls
   (no LISTEN/NOTIFY), so it behaves identically on any pooler and on Cloud SQL. The worker's state
   transitions are SECURITY DEFINER functions that only act while the caller holds the lease.
2. **Leases + heartbeat** instead of long locks: a crashed worker's job is re-claimed after the lease; a running job renews
   it, so a 10,000-row import is never taken over while it is running.
3. **Imports stage, validate, then apply.** Rows are streamed into `import_rows`; the dry run is one set-based UPDATE;
   applying is one statement per batch of rows. Row state changes in the same statement as the writes, so batches are
   idempotent and a resume continues with the rows still `valid`. One running import per tenant is a partial unique index.
4. **Invariants live in the database** (one current year, no overlapping terms, immutable parents, archive refusals,
   RESTRICT everywhere), with `btree_gist` for the term overlap (available on Cloud SQL).
5. **`profile_type` is a label**, not a permission.
6. **Formula injection is handled on both sides**: column-aware rejection on input, unconditional neutralization on output.

## Consequences

- New background work = a queue name + a handler in `<module>.handlers.ts`; `everyMs` makes it scheduled.
- Staged rows hold personal data: they are purged after `IMPORT_RETENTION_DAYS`.
- An API-enqueued job waits at most `JOB_POLL_MAX_INTERVAL_MS` for a worker (LISTEN/NOTIFY can shorten it later).

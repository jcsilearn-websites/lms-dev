# Benchmarks

Run with `pnpm bench` (autocannon against the real app on an ephemeral port).

## Local PostgreSQL 18 (dev machine) — 2026-10-29

Dev and tests moved to PostgreSQL 18 installed on the developer machine ([ADR 0011](adr/0011-local-postgres-for-dev-and-tests.md)).
Machine: Windows 10, Intel Core i3-1005G1 (2 cores / 4 threads), about 4 GB RAM free at best, Node 22.17.1, database on the same
host, so the network is out of the picture and the numbers below are database + application CPU. This is a weak laptop: treat
the absolute values as a floor. The remote numbers further down are kept for history only ("Supabase eu-west-1 (historical)").

### HTTP (`pnpm bench`, pool max 5, `UV_THREADPOOL_SIZE=8`)

| Endpoint                                     | req/sec | p50 ms | p99 ms | non-2xx |
| -------------------------------------------- | ------- | ------ | ------ | ------- |
| GET /health/live (c=50, 10s)                 | 6926    | 6      | 19     | 0       |
| GET /auth/me, authenticated (c=10, 10s) [DB] | 1079    | 8      | 18     | 0       |
| POST /auth/login (c=4, 15s) [DB + argon2id]  | 94      | 41     | 59     | 0       |

| Concurrency check                      | req/sec | p50 ms | p99 ms | non-2xx |
| -------------------------------------- | ------- | ------ | ------ | ------- |
| /health/live alone (c=20)              | 7486    | 2      | 6      | 0       |
| /health/live during login load (c=20)  | 2111    | 8      | 21     | 0       |
| POST /auth/login during that run (c=4) | 76      | 51     | 93     | 0       |

Event-loop delay while hashing: p50 11.8 ms, p99 21.9 ms, max 57.7 ms. Remote `/auth/me` was 22 req/sec (409 ms p50): that
was 100 % network latency; login is now bounded by argon2id on 2 cores (94/s).

### GET /members, first page of 50 rows, 5,001 members with student profiles (`bench:members`)

The bench now runs `ANALYZE` after loading the throwaway tenant (autovacuum would have done it in production). Without it
the planner kept the stale estimate of an empty table and `role + status` took 27 ms (median) instead of 0.4 ms: a reminder
that freshly bulk-loaded tables need statistics.

| Query (database side, no network, 15 runs, app role with RLS) | median ms | p95 ms |
| ------------------------------------------------------------- | --------- | ------ |
| first page, no filter                                         | 0.39      | 0.76   |
| `q = 'ra'` prefix search                                      | 0.53      | 0.68   |
| `role = member AND status = active`                           | 0.38      | 0.43   |
| section filter (50 rows)                                      | 0.41      | 0.66   |
| section + profile type filter                                 | 0.43      | 0.72   |

| Endpoint (c=10, 10 s)                                | req/sec | p50 ms | p99 ms |
| ---------------------------------------------------- | ------- | ------ | ------ |
| GET /members?limit=50 (first page)                   | 429     | 22     | 43     |
| GET /members?limit=50&q=ra (prefix search)           | 391     | 24     | 43     |
| GET /members?limit=50&role=member&status=active      | 440     | 22     | 34     |
| GET /members?limit=50&sectionId=<A> (section filter) | 423     | 22     | 45     |

### Member search design (`bench:search`, 20 tenants, 50,000 users, 54,739 memberships; largest tenant 7,063 members)

| Variant                                                   | worst p95 ms |
| --------------------------------------------------------- | ------------ |
| A: global indexes on `users` + join to the tenant         | 49.38        |
| B: tenant-scoped trigger-maintained keys (the one in use) | **8.92**     |
| no search term (keyset on the id)                         | 1.39         |

B stays well below the 20 ms threshold of the step 4 decision (A fails it); `EXPLAIN` of B for the largest tenant,
`q=ra`: 2.8 ms execution.

### Import throughput (`test/imports.scale.test.ts`, 10,000 students, batch of 500 rows)

Measured with the file run ALONE (no other test workers), worker statements counted on the worker's own connection.

| Phase                                                        | Before the SQL fixes | After                                          |
| ------------------------------------------------------------ | -------------------- | ---------------------------------------------- |
| Upload + dry run (stream into staging, validate)             | 25 - 41 s            | **1.0 - 1.6 s**, 16 statements                 |
| Processing (20 batches of 500 rows)                          | 21 - 61 s            | **7.2 - 8.9 s = ~1,130 - 1,380 rows/s**        |
| Worker statements                                            | -                    | 93 - 95 (4 per batch + start / finish / claim) |
| Dry run of a 3-row file in the same college (10,000 members) | **287 s**            | **0.09 - 0.12 s**                              |

Plain runs, processing: 7.3, 8.4, 8.3, 7.2, 8.9 s (the last one inside the full suite). Profile mode (`IMPORT_PROFILE=1`, which
also runs `EXPLAIN ANALYZE` on three batches) adds about 1 s: 8.9, 8.9, 12.8 s (the 12.8 s run had one 1.1 s batch statement: a
noisy laptop).

**Where the time goes now** (profile of the worker connection, 3 runs): 82 - 87 % of the wall time is inside the batch
statement on the server, 4 % is event-loop time in Node (CPU is not the limit). Per 500-row batch, about 340 ms:
`import_ensure_users` ~30 ms, the membership / profile inserts ~80 ms (of which the `member_profiles_derive` trigger 25 ms
and the foreign-key triggers ~3 ms each), the invite-job inserts ~60 ms, the row-status update ~200 ms (a 500 x 500
nested loop the planner prefers because it thinks the batch has 1 row; bounded by the batch, not by the college), counts
statement ~9 ms, BEGIN 0.4 ms, COMMIT ~4.7 ms. Lease heartbeat: none within 8 s (one per 10 s), polling: none while the
single job runs.

**What was wrong** (found with `EXPLAIN (ANALYZE, BUFFERS)` of each statement, all caused by the planner believing a table
it has no statistics for holds ~1 row, which is the state of every new college and of any just-loaded table):
1. dry-run update joined staged rows to the validation result with a nested loop: 99,990,000 rows removed by a join filter
   (40 s for 10,000 rows) - fixed by joining by `ctid`;
2. batch statement: the row-status update scanned the whole import per batch row (5,000,000 rows removed), the profile join
   was a materialized nested loop (2,250,000 removed), and two correlated `EXISTS` per row scanned the college's profiles
   (0.9 ms each x 500 x 2 per batch) - fixed with ctid/primary-key arrays, a unique-key lookup, and a sort-based check;
3. dry run, "register number already used by another member": per file row it joined EVERY membership of the college to
   every profile (rows x members^2): 287 s for 3 rows in a 10,000-member college, 48 s after an `ANY(array)` attempt that row-level
   security kept out of the index condition - fixed with a window function over the file's keys + the college's keys.

### Test suite (`pnpm test`, 3 database workers, 2-core laptop)

| Run | Total | Backend parallel (unit + db) | Backend serial | Frontend | Result |
| --- | ----- | ---------------------------- | -------------- | -------- | ------ |
| 1   | 118 s | 55 s: 42 files, 612 tests    | 58 s: 37 tests | 5 s      | green  |
| 2   | 120 s | 50 s                         | 66 s           | 4 s      | green  |
| 3   | 124 s | 54 s                         | 66 s           | 4 s      | green  |
| 4   | 123 s | 60 s                         | 57 s           | 6 s      | green  |

(Runs 1 - 3 were before the SQL fixes above, run 4 after them. The same suite took about 32 minutes on the remote database.)

# Supabase eu-west-1 (historical)

Everything below was measured against the remote Supabase dev database (about 200 ms per statement from the developer
machine, PostgreSQL 17) before the move to local PostgreSQL. Round trips and database-side times carry over; request
latencies and throughput do not.

### Baseline — 2026-10-28

Machine: developer laptop, Windows 10, Node v22.17.1, pool max 5, TLS `no-verify`.

| Endpoint                      | DB involved                                                           | req/sec | p50 ms | p99 ms | non-2xx | errors |
| ----------------------------- | --------------------------------------------------------------------- | ------- | ------ | ------ | ------- | ------ |
| GET /health/live (c=50, 10s)  | no                                                                    | 6939    | 6      | 18     | 0       | 0      |
| GET /health/ready (c=10, 10s) | **yes — remote dev DB (eu-west-1), not representative of production** | 23      | 395    | 1466   | 0       | 0      |

#### How to read these

- **/health/live** measures only Fastify + the Node HTTP stack on this machine (no DB). It is the useful
  framework-overhead baseline.
- **/health/ready latency includes the network hop to Supabase** (eu-west-1 from India: hundreds of ms per
  round trip, pooled via Supabase's Session pooler over TLS). An earlier run saw 3 non-2xx responses: readiness checks that hit
  the 2s `READY_TIMEOUT_MS` while queueing on the 5-connection pool; this run had none. In production (Cloud Run + Cloud SQL in the
  same region) expect a few ms. Re-baseline after the move; do not use the DB-dependent numbers for capacity planning.

### After the step 1b restructure — 2026-10-28

Same machine, Node v22.17.1, pool max 5. Old layout (commit ffb5b9c) vs new layout, interleaved on one machine
because the laptop's run-to-run noise is large:

| Run                     | old layout /health/live req/sec | new layout /health/live req/sec |
| ----------------------- | ------------------------------- | ------------------------------- |
| 1                       | 7089                            | 7051                            |
| 2                       | 7294                            | 6320                            |
| earlier new-layout runs | —                               | 5956, 6259, 6479                |

/health/live p50 stayed 5-7 ms and p99 17-38 ms in both layouts. New-layout runs trend ~8% lower on average than the
old layout (about 6400 vs 7000), inside the observed spread of ~15% between identical runs; there is no extra work on the
request path (one extra function call in the controller). /health/ready (remote dev DB, eu-west-1, not
representative of production): 21-23 req/sec, p50 ~418 ms, p99 ~1460 ms, 0 non-2xx. Re-measure on Linux/Node 24.

### Step 2: authentication — 2026-10-28

Same laptop (Windows 10, Node v22.17.1), pool max 5, `UV_THREADPOOL_SIZE=8`, against the seeded **remote dev DB
(Supabase eu-west-1) — not representative of production**. Every row that touches the database includes ~200 ms of
network round trip per statement.

| Endpoint                                                                                  | req/sec | p50 ms | p99 ms | non-2xx | errors |
| ----------------------------------------------------------------------------------------- | ------- | ------ | ------ | ------- | ------ |
| GET /health/live (c=50, 10s) — no DB                                                      | 7735    | 5      | 17     | 0       | 0      |
| GET /auth/me, authenticated (c=10, 10s) — login cost excluded; 1 DB statement per request | 22      | 409    | 1456   | 0       | 0      |
| POST /auth/login (c=4, 15s) — DB + argon2id                                               | 1       | 3102   | 3479   | 0       | 0      |

**What the numbers mean**

- `/auth/me` does exactly one indexed statement per request (`auth_lookup_session`: session + user + membership role +
  tenant status in one query, tenant slug from the in-memory cache, nothing else), so its latency is one remote round
  trip (~400 ms here) and its throughput is bounded by `pool size / round trip` (5 / 0.2 s ≈ 22 req/s). On Cloud SQL
  in the same region (~1 ms) the same statement is expected to be one to two orders of magnitude faster; re-measure after the move.
- Login is "intentionally CPU-heavy", but the CPU part is small: **one argon2id verification takes ~13 ms** (OWASP
  parameters m=19 MiB, t=2, p=1; median of 10 on this laptop). The 3.1 s p50 is ~15 sequential statements
  (tenant check, login lookup, membership check in a transaction, session insert in a transaction, session read-back,
  audit insert in a transaction) at ~200 ms each. Login p99 is 3.5 s here for the same reason.

**Login does not block other requests** (login load running while `/health/live` is measured):

| Scenario                               | req/sec | p50 ms | p99 ms | non-2xx |
| -------------------------------------- | ------- | ------ | ------ | ------- |
| /health/live alone (c=20)              | 7036    | 2      | 9      | 0       |
| /health/live during login load (c=20)  | 3707    | 5      | 19     | 0       |
| POST /auth/login during that run (c=4) | 1       | 3172   | 3457   | 0       |

Event-loop delay while logins hash (10 ms timer resolution): p50 10.8 ms, p99 21.7 ms, max 48.5 ms — i.e. the loop is
never blocked for more than ~40 ms and typically ~1 ms over the timer resolution. `/health/live` latency stays low
and stable (p99 9 -> 19 ms, no errors). The drop in its req/sec (7036 -> 3707) is CPU contention on this single laptop
(the load generator, the server and the argon2 threads share the same cores), not event-loop blocking.

### Step 2b: round-trip budget — before / after

Same laptop and **remote dev DB (eu-west-1) — not representative of production** (each statement ~200 ms here, ~1 ms on
Cloud SQL in the same region). "Round trips" = every statement sent to Postgres for one request, including BEGIN,
`set_config` and COMMIT and the deferred background work the request triggers (counted by `test/query-budget.test.ts`).

| Request                           | Round trips before | After | Budget |
| --------------------------------- | ------------------ | ----- | ------ |
| GET /health/ready                 | 1                  | 1     | 1      |
| GET /auth/me (authenticated)      | 1                  | 1     | 2      |
| GET /auth/me, admin host          | 1                  | 1     | 2      |
| POST /auth/login (success)        | **16**             | **2** | 4      |
| POST /auth/login (admin host)     | 8                  | 2     | 4      |
| POST /auth/login (wrong password) | 7                  | 2     | 4      |
| POST /auth/login (unknown email)  | 2                  | 1     | 4      |
| POST /auth/logout                 | **9**              | **2** | 3      |
| GET /auth/sessions (tenant read)  | 5                  | 4     | 4      |
| bad cookie / no cookie            | 1 / 0              | 1 / 0 | 1 / 0  |

How: login = `auth_login_begin` (tenant status + account + credentials + membership in one statement) -> argon2 verify ->
`auth_login_complete` (re-validate, clear failures, create session, audit in one statement); a failed login is one
deferred `auth_login_failed`. Logout, password reset and password change are one definer call each. `withTenant` /
`withUser` fuse `BEGIN` and the RLS context into one message (4 -> 3 statements for a single-query transaction).

| Endpoint                          | Before: req/sec / p50 ms / p99 ms | After: req/sec / p50 ms / p99 ms |
| --------------------------------- | --------------------------------- | -------------------------------- |
| GET /health/live (c=50) — no DB   | 7735 / 5 / 17                     | 7825 / 5 / 18                    |
| GET /auth/me (c=10) — 1 statement | 22 / 409 / 1456                   | 22 / 406 / 1470                  |
| POST /auth/login (c=4)            | 1 / 3102 / 3479                   | **9 / 426 / 741**                |

`/auth/me` is unchanged because it was already at the 1-statement floor (throughput = pool 5 / ~220 ms).
Login is ~7x faster at the median and ~9x the throughput; the remaining ~430 ms is two remote round trips plus one
~13 ms argon2id verification.

Login load vs. `/health/live` (the check that hashing does not block other requests):

| Scenario                                   | Before: req/sec / p50 / p99 | After: req/sec / p50 / p99 |
| ------------------------------------------ | --------------------------- | -------------------------- |
| /health/live alone (c=20)                  | 7036 / 2 / 9                | 7431 / 2 / 6               |
| /health/live during login load (c=20)      | 3707 / 5 / 19               | **7114 / 2 / 7**           |
| event-loop delay while hashing (p99 / max) | 21.7 / 48.5 ms              | 14.5 / 19.4 ms             |

The earlier halving of `/health/live` throughput came from the many sequential login statements keeping connections and
CPU busy on the laptop; with 2 statements per login it no longer moves. The benchmark now creates and deletes its own
throwaway tenant (`bench-<random>`) in the dev DB, so it no longer leaves sessions or audit rows behind.

### Step 4: member search design, and GET /members

Remote dev DB (eu-west-1) from a laptop: **not representative of production** for anything that includes the network.
Database-side execution times (EXPLAIN ANALYZE, no network) are the numbers that carry over.

#### Where should the prefix search live? (EXPLAIN experiment, `pnpm --filter @lms/backend run bench:search`)

Synthetic dataset in a throwaway schema (`bench_search`, dropped afterwards): 20 tenants, 50,000 users with common name
prefixes, 54,701 memberships, largest tenant 6,934 members, median tenant 2,326. The query ran as the **app role with RLS
on** (the real `users_select` policy), `LIMIT 51`, 15 runs per cell, database-side execution time:

| Variant                                                                                                                                  | worst p95                        | what it is                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A: global indexes on `users` (`lower(display_name)`, `email`, `text_pattern_ops`) + join to the tenant's memberships                     | **64.7 ms** (median up to 41 ms) | a 2-3 letter prefix first matches candidates across ALL tenants (or scans the tenant's rows and filters), plus the RLS `EXISTS` per user |
| B: tenant-scoped, trigger-maintained `search_name` / `search_email` on `tenant_memberships`, indexed `(tenant_id, key text_pattern_ops)` | **17.9 ms** (median 0.7-10.6 ms) | only the tenant's own rows are ever touched                                                                                              |
| no search term (keyset on the id)                                                                                                        | 1.7 ms                           | baseline                                                                                                                                 |

A exceeded the 20 ms threshold (e.g. `san` in the largest tenant: median 39.5 ms, p95 55 ms; `sa`: p95 64.7 ms), so
**variant B was chosen** (migration 0008). B's numbers are pessimistic: the experiment schema lacked the real table's
`(tenant_id, id)` index, so its planner walked the primary key and filtered; on the real tables the same query takes
3.4 ms (below). Costs of B: two small nullable columns per membership and two trigger functions (SECURITY DEFINER, because
the user row is not visible to `lms_app` before its first membership exists and a rename must reach every tenant).

#### GET /members, first page of 50 (`pnpm --filter @lms/backend run bench:members`)

Throwaway tenant with 5,001 members, deleted afterwards (`bench-*`), pool max 5:

| Query (database side, no network, 15 runs) | median ms | p95 ms |
| ------------------------------------------ | --------- | ------ |
| first page, no filter                      | 3.44      | 4.07   |
| `q = 'ra'` prefix search                   | 3.45      | 3.69   |
| `role = member AND status = active`        | 3.27      | 3.94   |

| Endpoint over HTTP (c=10, 10 s, remote DB)      | req/sec | p50 ms | p99 ms |
| ----------------------------------------------- | ------- | ------ | ------ |
| GET /members?limit=50                           | 4       | 2068   | 3673   |
| GET /members?limit=50&q=ra                      | 4       | 2085   | 4063   |
| GET /members?limit=50&role=member&status=active | 4       | 1958   | 3650   |

Each request is **4 round trips** (session lookup, BEGIN + set_config, the page, COMMIT) at ~220 ms each to the remote DB;
with a pool of 5 that caps throughput near 5 req/s here, which is what the table shows. On Cloud SQL in the same region
(~1 ms per statement) the same four statements plus ~3.5 ms of query time are a few milliseconds.

#### Round trips per endpoint (steady state; `test/query-budget.test.ts` enforces the budgets)

| Endpoint                                                                           | Round trips | Budget          |
| ---------------------------------------------------------------------------------- | ----------- | --------------- |
| GET /members (2 rows and 50 rows: identical, no N+1), GET /members/:id, GET /audit | 4           | 4               |
| PATCH role, POST suspend / reactivate, DELETE member, POST resend-invite           | 4           | 4 (approved: 5) |
| GET /platform/tenants, GET /platform/tenants/:id, GET /platform/audit              | 2           | 2               |
| PATCH / suspend / reactivate a tenant                                              | 2           | 2 (approved: 3) |
| POST /platform/tenants, POST /platform/tenants/:id/admin-invite                    | 3           | 3               |
| GET /platform/tenants/:id/members (two audit writes + the read)                    | 6           | 6               |

### Step 5: bulk import and GET /members by section

Remote dev DB (eu-west-1) from a laptop: every statement costs ~200 ms of network, so the HTTP and import wall-clock
numbers are NOT representative of Cloud SQL in the same region (~1 ms per statement). Round trips and database-side
execution times carry over.

#### Import throughput (`test/imports.scale.test.ts`, 10,000 students, default batch of 500 rows)

| Phase                                                                    | Time                                                                                                              | Round trips                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Upload + dry run (stream 10,000 rows into staging, set-based validation) | 32.7 s                                                                                                            | **16 statements** (7 fixed + 1 per 1,000 rows)                                               |
| Background processing (confirm -> worker applies 20 batches of 500 rows) | 66.4 s = **151 rows/s**                                                                                           | ~4 per batch (20 batches); 436 statements counted including the progress polling of the test |
| Result                                                                   | 10,000 accounts, memberships and student profiles; 10,000 invite jobs enqueued (none sent inside the transaction) |                                                                                              |

On Cloud SQL (same region, ~1 ms per statement) the same 20 batches are limited by the database work itself (a few
thousand rows per second); the point of the design is that the number of statements does not grow with the rows:
never a query per row.

#### GET /members, first page of 50 rows, 5,001 members with student profiles (`bench:members`)

| Query (database side, no network, 15 runs, app role with RLS) | median ms | p95 ms   |
| ------------------------------------------------------------- | --------- | -------- |
| first page (no filter)                                        | 3.09      | 3.88     |
| q = 'ra' prefix                                               | 2.90      | 3.01     |
| role + status filter                                          | 1.20      | 1.31     |
| **section filter (50 rows)**                                  | **0.56**  | **1.95** |
| section + profile type filter                                 | 0.54      | 0.63     |

Over HTTP against the remote DB: ~5 requests/s at c=10 for every variant (4 round trips x ~200 ms with a pool of 5),
including the section filter. The filter indexes `(tenant_id, section_id, membership_id)` keep the page in id order, so the
filtered page is as cheap as the unfiltered one.

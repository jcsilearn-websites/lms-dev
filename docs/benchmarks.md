# Benchmarks

Run with `pnpm bench` (autocannon against the real app on an ephemeral port).

## Local PostgreSQL 17 (dev machine) — 2026-10-29

Dev and tests moved to PostgreSQL 17 installed on the developer machine ([ADR 0011](adr/0011-local-postgres-for-dev-and-tests.md)).
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

## Frontend (step 5b) — 2026-10-29

Same laptop as above (2 cores, Node 22, PostgreSQL 17 on the same machine). The numbers come from `pnpm bundle:check`,
`pnpm e2e`, `pnpm lighthouse` and `pnpm test`; the budgets are enforced in CI (`bundle-size`, `e2e`, `lighthouse` jobs).

### Bundle (gzip, `frontend/scripts/check-bundle-size.mjs`, follows the real import graph of the page)

| Page / route                                                                               | JS gzip       | Budget     |
| ------------------------------------------------------------------------------------------ | ------------- | ---------- |
| Login page, initial load (entry + everything it imports statically)                        | **112.5 KB**  | 125 KB     |
| Login page after the first form interaction (+ the lazily loaded validation chunk 18.9 KB) | 131.5 KB      | (reported) |
| Largest route on top of the login page (member detail: react-hook-form + contracts)        | 40.1 KB       | 150 KB     |
| Other routes                                                                               | 0.7 - 38.2 KB | 150 KB     |

Where the login page's 112.5 KB goes: React DOM + JSX runtime about 69 KB, TanStack Router 21 KB, TanStack Query 12 KB,
application code about 11 KB. react-hook-form (12 KB) and the TypeBox contracts (19 KB) are NOT in it: the public
forms use a tiny form hook and load the validator on the first field focus (spike numbers: 117 KB for React + Router
- Query + react-hook-form alone, which is why the login budget is 125 KB and not the original 120 KB).

### Lighthouse (mobile preset: emulated phone, simulated slow 4G, 4x CPU slowdown; production-like server with brotli/gzip)

Median of 8 runs; the members list is signed in with 200 members (the first page of 25 is rendered).

| Page         | Performance | Accessibility | FCP    | LCP     | TBT    | CLS |
| ------------ | ----------- | ------------- | ------ | ------- | ------ | --- |
| Login page   | **97**      | **100**       | 752 ms | 2052 ms | 155 ms | 0   |
| Members list | **96**      | **100**       | 753 ms | 753 ms  | 224 ms | 0   |

Single runs vary a lot on this laptop (performance 90 - 99; one accessibility run of about 26 scored 86 and did not
reproduce), which is why the median is the figure. Before two fixes the members list scored a median of 82: the table AND the
card list were both rendered (double DOM), and the invite dialog statically pulled react-hook-form and the contracts into the
members route (37 KB gzip instead of 4.7 KB). Now only the layout that is shown is rendered and the dialog is a lazy chunk.

### Tests

| Suite                                                                         | Count                 | Time                                          |
| ----------------------------------------------------------------------------- | --------------------- | --------------------------------------------- |
| Component / hook tests (Vitest + Testing Library + MSW, typed from contracts) | 83 tests in 14 files  | 26 - 37 s                                     |
| End-to-end (Playwright, headless Chromium, real API + worker + PostgreSQL)    | 24 tests, serial      | 1.6 min (about 2 min with build and start-up) |
| Backend, unit + db in parallel / serial files                                 | 649 / 37 (+1 skipped) | 84 s / 70 s                                   |

E2E covers: sign in and out, wrong password, tenant isolation in the UI, invite -> accept -> sign in, password reset,
member suspend / reactivate (and the suspended person is locked out), academic setup (department -> program -> batch ->
section, and a 409 conflict), the CSV import with one bad row (error report, skip invalid, progress, summary), the platform
admin creating a college whose admin accepts the invitation, suspending a college, college branding per theme, and axe
(fails on serious or critical violations) on every main screen in light, dark and at 360 px.

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

### Step 6: courses, content and the enrolment sync (`bench:courses`, local PostgreSQL 17, one laptop)

`pnpm --filter @lms/backend run bench:courses` builds a throwaway college ("bench-…", deleted afterwards): 10,000
students in 10 sections, 200 courses with an offering each, every offering enrolling one section (20 offerings per
section), and a learner in 8 offerings, one of them with 20 modules x 15 items. HTTP through Fastify with 8 connections,
8 seconds each. Every request costs 4 statements (budget tests in `query-budget.courses.test.ts`); against a remote
database the milliseconds grow by ~200 per statement, the statement counts do not.

| Request                                                          | req/s | p50   | p99    | Round trips                                                          |
| ---------------------------------------------------------------- | ----- | ----- | ------ | -------------------------------------------------------------------- |
| `GET /offerings/:id/outline`, learner, **20 modules x 15 items** | 129   | 57 ms | 136 ms | **4** (ONE statement for the whole outline, session lookup included) |
| `GET /me/courses`, learner in **8 offerings**                    | 184   | 34 ms | 163 ms | 4                                                                    |

#### One student moves section, 10,000 students, 200 offerings (the incremental sync)

| Step                                                  | Result                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| The move itself (`POST /members/:id/profile/section`) | 75 ms, 4 round trips; the trigger records **1** pending row and queues one job   |
| The sync that applies it (1 member, 1 batch)          | **8 ms**: that student's 20 enrolments removed and 20 added                      |
| For comparison: the first sync of the whole college   | 10,000 members in 50 batches of 200 = 61.1 s, 200,000 enrolments (~3,300 rows/s) |

The cost of a change follows the number of changes (1 member = 8 ms), not the size of the college (10,000 members =
61 s). The first sync happens once, when sections are first enrolled; a batch is one short transaction that also deletes
the pending rows it applied, so a crash or a retry never loses or repeats a change.

#### Step 6b: the first full-college sync, profiled and fixed (10,000 students x 200 offerings, 200,000 enrolments)

`SYNC_PROFILE=1 [SYNC_PROFILE_AFTER=20] pnpm --filter @lms/backend run bench:courses` prints the per-batch wall times of the
first sync and writes `EXPLAIN (ANALYZE, BUFFERS)` of one batch (`SYNC_PROFILE_OUT`, default `sync-profile.txt`).

| Where the time went (first sync, 50 batches of 200 members)              | Before                                                                                                                                                                                | After                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Whole first sync                                                         | **61 s** (39 s after fix 1)                                                                                                                                                           | **7.6 - 16.6 s**, median 10.4 s (see below) |
| Batch time as the table fills                                            | 0.5 s growing to **3.1 s** (batch 28), then 0.27 s once autoanalyze ran                                                                                                               | flat, 0.22 - 0.31 s                         |
| Planner choices without statistics (a college that was just bulk-loaded) | seq scan of course_participants per member (40,200 probes); `search_email` index chosen for a primary-key lookup (2,700 buffers per probe); every offering x every member nested loop | index probe per member everywhere           |

What was wrong, found with EXPLAIN (ANALYZE, BUFFERS):
1. **Planner estimates** (the rule in CLAUDE.md "Set-based SQL must not depend on the planner's estimates"): the Step 6b
   statements that close and restore participations scanned `course_participants` once per member (5.9 s of a 6.3 s batch); the
   membership lookup used a `(tenant_id, search_email)` index for a primary-key lookup. Fixed by looking each member up by its
   unique key in a `LATERAL ... OFFSET 0` (materialized CTEs per step), comparing only `id` for the membership and offering
   lookups, and `set_config('enable_seqscan', 'off', true)` for the sync transaction (every lookup has an index; the
   batch time stopped growing with the table).
2. **An unused index** (`course_participants_section_idx`) was maintained for every one of the 200,000 rows (migration 0024).
3. **v7 ids matter**: with random v4 ids the same batch took 0.55 s instead of 0.22 s (random inserts into five b-trees).

What is left is inherent: inserting 200,000 rows with 4 indexes, 3 foreign-key checks per row (~23 us each, 40% of the statement),
a plpgsql `lms.uuid_v7()` (~9 us) and one commit per batch, ~50 us per row = 10 s. The 7.6 - 16.6 s spread between runs on this
2-core laptop comes from autovacuum working on the previous run's deleted data (the benchmark now vacuums first, which narrowed
but did not remove it) and from the database sharing the CPU with the benchmark. So: under 10 s on a quiet machine
(7.6 s measured), about 10 s typically, 16 s worst; `concurrency` (batches applied in parallel, different members each) is
implemented but left at 1 because it was not faster on 2 cores (17.7 s vs 13 s in a noisy pair of runs): measure it on Cloud SQL.
A single student moving section is unaffected: 1 pending row, one batch of 1 member (9 ms; one run showed 2 s while autovacuum was running).

## Step 7: video lessons — 2026-10-30

Details, method and the size numbers per rendition: [video-cost-model.md](video-cost-model.md). Reproduce with
`pnpm --filter @lms/backend run bench:video` (ffmpeg `n8.1.3-9-g29e619e767`; 4 x i3-1005G1 @ 1.20 GHz, Windows).

| what                                                                                              | result                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| transcode, lecture-like 1280x720 (clean slides), 3 renditions, one ffmpeg run, `-preset veryfast` | 300 s of video in 77 s: **3.9x real time** (about 15 min of work per hour of video)                                        |
| transcode, high-motion 1280x720 (noise, hits every bit-rate cap)                                  | 300 s in 203 s: **1.5x real time** (about 40 min per hour of video)                                                        |
| size of a viewing hour, fMP4: 360p / 480p / 720p                                                  | lecture-like **0.033 / 0.048 / 0.049 GB**; high-motion **0.211 / 0.361 / 0.631 GB** (the caps: at most 0.21 / 0.36 / 0.63) |
| MPEG-TS instead of fMP4 (same encode, lecture-like)                                               | 31-51 % larger                                                                                                             |
| `POST /offerings/:id/items/:itemId/playback` (10 connections, 8 s)                                | 193-236 req/s, **p50 40-49 ms, p99 69-93 ms**, 4 round trips                                                               |
| 20 consecutive playback file requests of one session                                              | **1** database statement (the other 19 hit the session cache)                                                              |
| a hand-cut, test-sized upload (resumable, 32 KB chunks)                                           | each chunk 4 round trips; the video tests run end to end in about 25 s including real transcodes                           |
| player chunk (hls.js light)                                                                       | 113 KB gzip, loaded on Play / hover only; login page unchanged                                                             |
| Lighthouse (mobile, median of 3) video item page                                                  | performance 94, accessibility 100 (this machine; neighbouring pages 91-97 in the same run)                                 |

## Step 8: learning progress — 2026-10-31

Reproduce with `pnpm --filter @lms/backend run bench:progress` (a throwaway `bench-*` college in the dev database, deleted
afterwards; `HEARTBEAT_SECONDS`, `HEARTBEAT_CONNECTIONS`, `ANALYZE_ALL=1`, `CLASS_PROFILE=1`, `HB_EXPLAIN=1` for the plans). 4 x i3-1005G1
@ 1.20 GHz, Windows, PostgreSQL 17 on the same machine as the API and the load generator (they share the CPU). 500 learners x 100
items, about 24,000 progress rows, **no statistics gathered** (a college whose rows were just loaded: the worst case for the planner).

| what                                                                                              | result                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| heartbeat over HTTP (99 learners, 64 connections, 10 s, every request a NEW heartbeat)            | **436 req/s**, p50 139 ms, p99 304 ms, no errors; 2 round trips each                                              |
| same machine, `GET /auth/me` (session lookup only)                                                | 878 req/s: a heartbeat costs about twice a bare request here                                                      |
| the heartbeat function alone (no HTTP), 8 connections                                             | **1,309 calls/s**, p50 5.6 ms, p99 11.9 ms (CPU bound: the database shares 2 cores with Node and the load tool)   |
| class view, page of 100 of 500 learners x 100 items (service call: transaction + ONE statement)   | median **47 - 51 ms** by name / progress / activity, 37 - 38 ms with a status filter, p95 50 - 66 ms              |
| class view, second page (keyset)                                                                  | median 48.6 ms                                                                                                    |
| one learner, item by item                                                                         | median 6.5 ms                                                                                                     |
| counters instead of aggregation: the same percentages from one counter row per learner and module | **6.0 ms** read, but **+15 %** on every write and a set-based repair of 500 x 10 rows on every denominator change |

What the benchmark found and fixed (all of it is the CLAUDE.md rule "Set-based SQL must not depend on the planner's estimates"):
1. **The class view took 340 - 1,000 ms** (the target was 50). `EXPLAIN (ANALYZE, BUFFERS)` showed (a) the per-learner module
   percentages scanning the whole `done` CTE for every learner and module (2.6 ms x 101 rows), (b) in a college without
   statistics the planner treating the page as one row, inlining the module aggregate as a subplan and running it once per row
   (51,510 correlated counts), (c) a nested loop re-reading a hash join 501 times (250,000 rows removed by a join filter). Now: one
   row per learner (`done_m` with a `{moduleId: completed}` object), the page first and its module shares for the 101 rows only,
   the steps that must run once marked `MATERIALIZED`, the module totals from one `GROUP BY`. 340 - 1,000 ms -> 47 - 51 ms, stable.
2. **The rule every heartbeat starts with** (`learner_item_access`) joined `course_participants` to `tenant_memberships` with the
   user filter applied after the join: every heartbeat read all participants of the offering (28 ms for 500 learners, growing with
   the college). Migration 0027 rewrites it as a chain of unique-key lookups (`LATERAL ... OFFSET 0`): about 1 ms, and the
   function alone went from 842 to 1,309 calls/s.

The 1,000 heartbeats/s target is **not met over HTTP on this machine** (436/s). What is measured: the database function sustains
1,309/s with 8 connections while sharing 2 cores with the API and the load generator, and the HTTP path is bounded by Node plus
its two statements (the session lookup alone tops out at 878/s here). A heartbeat is one statement-sized call on a stateless API,
so the capacity scales with API instances and Cloud SQL cores; confirm on Cloud SQL (a separate database host) before promising a
number. Not done, with the expected gain: one fewer statement inside the function for the common case (look the row up with
`FOR UPDATE` first and insert only when it is missing: about 10 - 15 %). With a heartbeat every 30 s, 1,000 heartbeats/s is about
30,000 learners watching at the same moment.

### Percentages: aggregation or counters (decision)

Counters (one row per learner and module, kept by a trigger) read in 6 ms against 47 ms and cost +15 % on every completion.
**Aggregation was kept** because (1) the class view is a staff-only, keyset-paged read (a few requests a minute, not one per
learner), 47 ms is acceptable, and it needs the progress rows anyway for status, "behind" and last activity; (2) counters must be
repaired for every learner whenever the DENOMINATOR changes (an item added, unpublished or archived, a module published, and
**time itself**: an item whose `available_from` passes becomes part of everyone's total at that moment, which needs a scheduler to
keep a counter right); (3) the learner's own views read only their own rows by primary-key prefix, never the class. If a college
grows to a class view that must answer in a few milliseconds, add the counters then, behind the same repository function.


## Step 9: quizzes and exams — 2026-10-31

Reproduce with `pnpm --filter @lms/backend run bench:assessments` (a throwaway `bench-*` college in the dev database, deleted
afterwards; `BENCH_LEARNERS`, `BENCH_CONNECTIONS`, `BENCH_REALISTIC_SECONDS`, `BENCH_WORST_SECONDS`, `BENCH_SATURATION_SECONDS`).
4 x i3-1005G1 @ 1.20 GHz (2 cores really busy), Windows, PostgreSQL 17 on the same machine as the API and the load generator
(they share the CPU: **a laptop, so read every number as a floor, not as a Cloud Run + Cloud SQL figure**).
**1,500 learners**, one 60-minute exam of **50 questions** drawn by three random pools from a bank of 300 (20 easy single choice,
20 medium multiple choice with partial credit, 10 hard numeric / short answer), shuffled questions and options, **no table
statistics** (a college whose rows were just loaded) and autovacuum paused on the exam tables so it cannot analyze mid-run.
Requests go over HTTP through the real API (sessions are inserted directly: a login hashes a password and 1,500 of them would
take minutes).

| what                                                                                                               | result                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **start**: 1,500 learners (64 connections): one database call draws, shuffles and stores 50 questions              | 35 - 150 starts/s over three runs; all 1,500 started in **10 - 43 s** (target: within 60 s); p50 0.4 - 1.8 s, p99 0.6 - 2.0 s |
| resume read (a page load: 50 questions with saved answers and revisions), 1,500 learners                           | 250 req/s, all in 6 s; p50 238 ms, p99 325 ms                                                                                 |
| **autosave, realistic**: each learner changes an answer every ~30 s (**50 saves/s**), 30 s                         | **52 req/s, p50 22 ms, p99 160 ms**, 0 errors, every save applied                                                             |
| **autosave, worst case**: everybody saves every 3 s (**500 saves/s**), 20 s                                        | **501 req/s, p50 47 ms, p99 109 ms**, 0 errors                                                                                |
| autosave, saturation (as fast as this machine goes), 15 s                                                          | **592 - 672 req/s**, p50 94 - 103 ms, p99 120 - 180 ms, 0 errors                                                              |
| **submit burst**: all 1,500 hand in at once; each call scores 50 answers                                           | 300 req/s, the whole class in **5 s**; p50 192 ms, p99 298 ms (the target was the last 2 minutes)                             |
| **auto-submit with the browsers closed + grading time**: the sweeper closes and scores 1,500 x 50 = 75,000 answers | **3.9 - 4.1 s** in batches of 200, one statement each = 362 - 381 attempts/s; 0 attempts left open                            |
| regrade of one question (credit) over 1,500 attempts: dry run / apply                                              | 39 - 46 ms / 73 ms                                                                                                            |
| final scores of the offering (the gradebook interface), 1,500 learners                                             | 44 - 53 ms                                                                                                                    |
| attempts list page (50 rows)                                                                                       | 5 ms                                                                                                                          |
| item analysis of 1,500 attempts x 50 questions                                                                     | **417 ms** (9.3 s before the fix below)                                                                                       |

How to read it:
- The load pattern the product asked for (1,500 learners, a change every 20 - 40 s) is **50 saves/s: p99 160 ms and about a tenth of
  what this laptop can do**. The worst case (everybody every 3 s) is **500/s, still p99 109 ms**; the save path does not degrade
  until saturation at about 590/s, where the machine, not the database, is the limit (CPU shared with Node and the load tool).
  Every statement on these paths is a primary-key or unique-key lookup (the attempt row, the 50 `attempt_questions` rows by
  primary key, a version by unique key); no request scans the class.
- Saves are HOT updates (the answer column has no index) on a `fillfactor 70` table, one row per question.
- The start is the heaviest call (random draw of 50 from 100 candidates per pool, shuffle, 51 inserts). It varied a lot between
  runs on this shared laptop: 150/s (10 s), 107/s (14 s) and, in the last run right after the suite, 35/s (43 s, p99 2 s). All are
  inside the 60 s target but the 43 s one is not comfortable: the draw (`ORDER BY random()` over each pool's candidates) is the
  place to optimise first if starts become the bottleneck on Cloud SQL (a pre-numbered candidate table would make it a lookup).
- Grading the whole class at the deadline is **set based**: 200 attempts (10,000 answers) per statement, joined to the versions by
  unique key (`LATERAL ... OFFSET 0`), scored by `lms.score_answer`; 1,500 x 50 in about 4 s. A person-graded essay is not in this number.

What the benchmark found and fixed (the CLAUDE.md "planner lesson" again):
1. **The item analysis took 9.3 s** for 1,500 x 50: the option distribution was read by a correlated subquery over a CTE that
   PostgreSQL re-evaluated for every option of every question. `per` and `picks` are now `MATERIALIZED` (417 ms now).
2. Nothing else was needed: the exam-time functions were written as unique-key lookups from the start, measured in the
   statistics-free state, and the regrade and analysis statements use `MATERIALIZED` steps and one row per attempt before joining.

Laptop caveat, again: the figures are for one 2-core laptop where the API, PostgreSQL and the load generator compete. Confirm on
Cloud SQL (a separate host) before promising a number; autosave scales with API instances and database cores, because a save is one
2-statement request on a stateless API.


## Step 10: assignments — 2026-11-11

Reproduce with `pnpm --filter @lms/backend run bench:assignments` (a throwaway `bench-*` college in the dev database and its stored
files, both deleted afterwards; `BENCH_LEARNERS`, `BENCH_QUEUE_LEARNERS`, `BENCH_CONNECTIONS`, `BENCH_PACED_SECONDS`,
`BENCH_FILE_KB`, `BENCH_ZIP_FILE_KB`). 4 x i3-1005G1 @ 1.20 GHz (2 cores really busy), Windows, PostgreSQL 17 on the same machine
as the API and the load generator (they share the CPU: **a laptop, so read every number as a floor, not as a Cloud Run + Cloud SQL
figure**). **1,500 learners**, **no table statistics** (a college whose rows were just loaded) and autovacuum paused on the tables
of the run. Requests go over HTTP through the real API with the real storage abstraction (signed URL, the local driver streams the
bytes to disk; the API never holds a file in memory). Sessions are inserted directly (a login hashes a password).

**The deadline burst**: 70% hand in ONE PDF of about 2 MB, 20% text only, 10% three files (700 KB each). Every file is four calls:
upload request, PUT of the bytes, confirm (the server reads the bytes, checks type against content, hashes them), then the finalize.

| what                                                                              | result                                                                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **saturation**: all 1,500 at once, 64 in flight, 2.4 GB uploaded                  | all 1,500 handed in in **43 - 52 s** over four runs, 0 failed, 372 - 457 statements/s                                                        |
| upload request / PUT / confirm / **finalize**                                     | p99 659 - 786 ms / 868 - 4,000 ms / 1,231 - 2,492 ms / **595 - 738 ms** (p50 of the finalize 276 - 298 ms)                                   |
| the whole flow of one learner                                                     | p50 1.8 - 2.3 s, p99 4.4 - 6.1 s                                                                                                             |
| **paced**: 1,500 arrivals over 180 s, the density rising to ~17/s at the end      | 0 failed; upload request p99 181 ms, PUT 180 ms, confirm 268 ms, **finalize p99 146 ms**; whole flow p99 633 ms                              |
| **the same, squeezed into 60 s** (about 10x the density of "the last 10 minutes") | 593 of 1,500 FAILED with a 500 (below); after the fix: **0 failed**, 1,613 `503 busy` answers retried after Retry-After, whole flow p99 70 s |
| queue, first open for 500 learners (makes the random keys, then reads)            | **281 ms**                                                                                                                                   |
| queue page (50 rows) / 100 rows by time / `status=late`                           | p50 37 / 26 / 23 ms, p95 86 / 34 / 32 ms                                                                                                     |
| class status (the summary, one row per status)                                    | p50 20 ms, p95 22 ms                                                                                                                         |
| one learner for grading / save a grade (rubric summed in SQL, audited)            | p50 11 / 13 ms, p95 15 / 31 ms                                                                                                               |
| release 500 grades in one statement (the penalty frozen on each)                  | **90 ms**                                                                                                                                    |
| final scores of the offering (the gradebook interface), 500 learners              | 6 ms                                                                                                                                         |
| **ZIP of 500 submissions** (500 x 2 MB = 1,000 MB), streamed                      | **6.8 s = 147 MB/s**; the API process RSS 188 MB before, **peak 252 MB (+63 MB)** while streaming 1 GB                                       |

How to read it:
- Finalizing is the cheap part: **2 round trips** (the session lookup and one definer call). What costs is the bytes: the PUT streams
  2 MB to disk and the confirm reads and hashes it, both CPU and disk on this one shared laptop. With the burst squeezed into
  seconds the 64 in-flight uploads dominate; in the paced run (the realistic shape) every step stays under 300 ms at the 99th percentile.
- The load the product promises is "1,500 learners in the last 10 minutes": 2.5 arrivals per second on average and about 5 per
  second at the peak. The paced run is 3.4 times denser than that at its peak and the squeezed one 10 times.
- The ZIP is flat in memory: a 1 GB archive costs +63 MB of resident memory in the API (the writer holds one chunk and the central
  directory, about 100 bytes per entry). Validated by `unzip -t` and Python's `zipfile`, also in the ZIP64 form.

What the benchmark found and fixed (the CLAUDE.md "planner lesson", this time about back-pressure):
1. **Under the 60 s burst 593 hand-ins failed with `500 internal_error`**, on every endpoint: the database pool (5 connections in
   development, `connectionTimeoutMs` 5 s) had no free connection for longer than that, and pg-pool's "timeout exceeded when trying
   to connect" was an unhandled error. It is now a **`503 busy` with `Retry-After: 2`** (central error handler, tested), which every
   client of the hand-in flow can retry because each call is idempotent (the request key, the draft files, the confirm). With the
   retry the same burst finishes with 0 failures. The same applies to the exam endpoints of Step 9.
2. Nothing else: the learner calls were written as unique-key lookups from the start, the grading statements aggregate to one row
   per learner before any join and were measured without statistics, and the queue's keys are made once per assignment.

Laptop caveat, again: the figures are for one 2-core laptop where the API, PostgreSQL, the disk and the load generator compete.
Confirm on Cloud Run + Cloud SQL + a bucket before promising a number: uploads then bypass the API entirely (signed URLs straight to
the bucket) and the confirm reads object metadata instead of re-reading the bytes (GCP step).

## Step 10b: deadline fairness under load — 2026-11-12

`pnpm --filter @lms/backend run bench:assignments`, section 1b (a throwaway college, no statistics, one laptop, local PostgreSQL 17).
1,500 learners (70% one PDF, 20% text, 10% three files) arrive with a rising density over the first 54 s before a deadline 60 s away
(`BENCH_FAIR_SECONDS`); the whole flow (upload request, PUT, confirm, finalize) runs through the same client as the SPA: a 503 `busy` is
retried after Retry-After + backoff + jitter with the receipt of the first refusal. Late work is allowed for another hour, so a late mark
would be recorded, not refused. The check compares the time each finalize was FIRST sent (client clock) with the stored `late_seconds`.

| Result                                                                                                          | Value                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| hand-ins accepted / failed                                                                                      | 1,500 / 0 in 72 s (272 statements/s) |
| busy (503) answers retried                                                                                      | 186                                  |
| late marks for a finalize first sent before the deadline (**unfair**)                                           | **0**                                |
| finalizes refused busy before the deadline and accepted only after it, still on time (protected by the receipt) | 39                                   |
| finalize p50 / p95 / p99                                                                                        | 628 ms / 3.9 s / 8.7 s               |

The run fails (non-zero exit) if any unfair late mark is found. Nobody FIRST sent a finalize after the deadline in this run (the arrivals
stop at 54 s); "a request that arrived after the deadline is late even with retries" is covered by `test/deadline-fairness.test.ts`.
The earlier sections are unchanged: saturation 1,500 hand-ins in 45 s with 0 busy answers; paced 180 s with 13 busy answers retried.

### Lighthouse "Course (learner)": was 86-89 noise? (Step 10b)

`LH_RUNS=1 LH_ONLY="Course (learner)" node scripts/lighthouse.mjs`, one process per sample, the variants interleaved (A, B, A, B, ...) so
machine drift hits all of them; A = the Step 9 commit (`4ba98db`, a throwaway worktree, nothing committed, same Lighthouse script),
B = the current code and demo data, C = the current code with the demo assignment archived (`LH_NO_ASSIGNMENT=1`: the data of Step 9).

| Variant                     | n   | performance (sorted)          | median   | median LCP |
| --------------------------- | --- | ----------------------------- | -------- | ---------- |
| A Step 9                    | 10  | 86 90 93 94 95 96 96 96 97 97 | **95.5** | 1.9 s      |
| B Step 10 (before the fix)  | 10  | 80 83 87 87 89 89 92 96 96 97 | **89**   | 3.3 s      |
| C Step 10 code, Step 9 data | 5   | 88 96 96 97 97                | 96       | 1.9 s      |

It is partly noise (the score is bimodal: LCP 1.9 s or 3.3 s, A has 86 too) but the gap is real: B was slow in about 6 of 10 runs, A in 2-3.
The code difference between the two commits on this page is a few lines; the data is what changed the odds. The LCP element is the course
heading, and the page rendered nothing but a skeleton until BOTH the offering and the outline (the slower request, and larger now that the
course has an assignment) had arrived, so the heading's paint moved with the slower response. **Fix** (`OfferingPage.tsx`): the title and
header render as soon as the offering has loaded (the outline has its own skeleton below, with its own error state), and the room of the
progress bar is reserved so nothing moves when it arrives. After the fix, interleaved with Step 9, 6 runs each: A 96 96 96 96 96 93, B
96 96 96 96 96 97, medians **96 and 96**.

## Step 11: the gradebook

`pnpm --filter @lms/backend run bench:gradebook` (a MIGRATED database: `DATABASE_URL` / `DATABASE_APP_URL` name it; the run used a
test database on the 2-core development laptop, PostgreSQL 17 native, local). A throwaway college (`bench-<random>`, deleted in a `finally`):
N learners x 60 items = 50 manual columns (90 % filled) + 5 quizzes + 5 assignments, five categories (weighted, drop-lowest 0-2, half of them
"zero after due"), a grade scale, `out_of` 40. Measured as the APP role with the college set, first on the FRESH college (no statistics: what
a newly loaded college looks like; measured BEFORE any ANALYZE) and then after `ANALYZE`. Medians of 5 runs (3 for the heavy ones).

| Statement (DB time)                                           | 500 x 60 fresh | 500 x 60 analyzed | 1,200 x 60 fresh | 1,200 x 60 analyzed |
| ------------------------------------------------------------- | -------------- | ----------------- | ---------------- | ------------------- |
| compute, every learner, no explanation (the whole grid)       | 909 ms         | 863 ms            | 2,387 ms         | 2,386 ms            |
| a grid chunk of 500 learners (compute + the JSON of the rows) | 1,111 ms       | 984 ms            | 1,295 ms         | 1,151 ms            |
| compute with the explanation of EVERY learner                 | 1,377 ms       | 1,332 ms          | 3,615 ms         | 3,583 ms            |
| lock: approve (compute with explanations + snapshot insert)   | 4,248 ms       | not repeated      | 4,345 ms         | not repeated        |
| review (problems + excluded + stats: compute twice)           | 1,975 ms       | 1,937 ms          | 5,084 ms         | 4,979 ms            |
| 500 mark cells saved + recompute of their rows                | 1,192 ms       | 930 ms            | 1,175 ms         | 1,202 ms            |
| ONE learner's view (`gradebook_me`)                           | 91 ms          | 97 ms             | 249 ms           | 251 ms              |
| ONE learner's staff explanation                               | 100 ms         | 131 ms            | 282 ms           | 281 ms              |

**Reading the numbers.**

- **The target (~100 ms for 500 x 60 in one statement) is NOT met.** The calculation is ~0.9 s for 30,000 cells (30 µs a cell) and grows
  linearly (72,000 cells: 2.4 s). The work is exact fractions, not planner luck: the plan is the same with and without statistics. A chunk of
  500 learners of a 1,200 learner class costs ~1.2 s, so the grid fills in over about three round trips of ~1 s each, while the first 500
  rows are already usable. Where the time goes (EXPLAIN ANALYZE): about a third building the 30,000 cells (eight hash joins), a quarter the
  sort of the drop-lowest window and the fraction aggregates, the rest the JSON of cells and totals. Ideas not done: keep the per-item scores
  in a materialised table updated by triggers, or compute only the learners of the visible chunk's sections (the grid already does this per
  chunk: the cost per chunk is the cost of its learners, plus ~90 ms of fixed work that every call pays).
- **The planner lesson held again, harder.** Called with parameters (as the application does) the function took **47 s** on a fresh college
  where the same statement inlined with literals took 1 s: with unknown parameters and no statistics the planner chose nested loops over
  the 30,000-cell join. `SET enable_nestloop = off` on the function fixes it (1.1 s) and is in the migration with the measurement in its
  comment. The bench exists to catch exactly this regression.
- Fixed cost: a call for ONE learner still costs ~90 ms (planning a 20-step statement ~50 ms and a scan of the quiz and assignment scores of the
  whole offering). That is what `gradebook_me` and the explanation pay; their round trips are 2 and 4.
- Round trips (`query-budget.gradebook.test.ts`): every staff call 4, the learner's page 2, the export 4 + 3 per page of 500 learners.

### Lighthouse (mobile, median of 3), Step 11

| Page           | Performance | Accessibility | LCP   | TBT     |
| -------------- | ----------- | ------------- | ----- | ------- |
| Gradebook grid | 87-90       | 100           | 3.1 s | ~230 ms |
| My grades      | 96          | 100           | 2.6 s | 105 ms  |

The grid page sits on the edge of the budget (87-90 over repeated runs; "Class progress", the page most like it, scored 92 in the same sessions):
its code is split (the settings, import and explanation panels are chunks of their own), its data is prefetched by the route loader, its header
renders before the data, and the grid does not scroll on mount. What is left is the lazy page chunk plus four parallel requests behind the
simulated 4x CPU. The demo has 3 learners; a 500-learner grid is as cheap to paint (the grid is virtualized in both directions).

## Step 11b: the gradebook, faster (profile, restructure, before / after)

Same bench (`pnpm --filter @lms/backend run bench:gradebook`, a fresh college WITHOUT statistics, the app role, medians). The bench now FAILS
when the one-learner view at 1,200 learners costs more than 1.5x the one at 500 (it costs 1.0x).

**Where the 909 ms went** (500 x 60, `EXPLAIN (ANALYZE, BUFFERS)` of the statement body and a stage-by-stage re-run that stops the statement
after each step; planning ~50-75 ms is on top of every cold call):

| Step                                                             | before  | what it was                                                                                                             |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| the whole-offering score functions (quizzes, assignments, marks) | ~125 ms | read for the whole class, also for ONE learner                                                                          |
| the 30,000 cells (nine joins to every cell, one query)           | ~450 ms | `cell` and the state / fraction columns: wide rows copied through three `MATERIALIZED` steps (spilled: `temp read=577`) |
| drop-lowest (one global window sort with a 40-digit numeric key) | ~100 ms | sorted 30,000 rows to find the lowest of ten                                                                            |
| exact sums: the fraction aggregate called once per cell          | ~110 ms | 30,000 calls of an SQL transition function                                                                              |
| the JSON of cells, totals, explanation (`jsonb`)                 | ~250 ms | key sorting and parsing of 30,000 cells                                                                                 |
| the final (rounding three times, a grade probe per learner)      | ~50 ms  |                                                                                                                         |

The custom fraction aggregate was NOT the main cost (~110 of 909 ms). What was done, each measured:

1. **One learner no longer reads the class** (one-learner view 91 ms -> 13 ms; 249 ms -> 13 ms at 1,200): the sources are limited to the learners
   and items asked for (index lookups by array; unique-key `LATERAL` probes for the quizzes and assignments when at most 25 learners are asked
   for), the learner is found by primary key, and `plpgsql` keeps the plan of the 25-step statement for the session (it was planned on every call).
2. **Cells per source** (manual / assessment / assignment): a manual cell joins one table, not nine. No title in the 72,000 cells.
3. **`json`, not `jsonb`** for cells, totals and the explanation (no key sorting, no parsing of 30,000 cells); the lock casts once.
4. **Exact sums with native `sum()` per (learner, category, denominator)**; the fraction aggregate sees the handful of groups, not every cell.
   The arithmetic is unchanged (fractions, one rounding): the property tests against the BigInt reference pass without a change.
5. **Drop-lowest by an ordered array per (learner, category)** instead of one window sort of the whole class, and only for categories that drop.
6. **The final computed once**; **`work_mem` 32 MB and no merge joins** (with nested loops gone the planner chose merge joins whose sorts of 60,000
   rows spilled to disk: -25 %).
7. A bug the bench found on the way: a first version that joined every source to a `lim` CTE took 37 s (nested loops over arrays) in a
   fresh college. `SET enable_nestloop = off` and the index-by-array form fixed it (see the ADR for why it stays).

| 500 learners x 60 items (fresh college)            | before   | after        | target             |
| -------------------------------------------------- | -------- | ------------ | ------------------ |
| whole class, no explanation                        | 909 ms   | **439 ms**   | <= 300 ms (missed) |
| a chunk of 500 learners (grid JSON built)          | 1,111 ms | **494 ms**   | <= 300 ms (missed) |
| whole class with explanations (the lock's compute) | 1,377 ms | 641 ms       |                    |
| lock: approve                                      | 4,248 ms | **1,030 ms** | <= 2 s (met)       |
| ONE learner (`gradebook_me`)                       | 91 ms    | **13.5 ms**  | <= 30 ms (met)     |
| review (compute twice)                             | 1,975 ms | 957 ms       |                    |

| 1,200 learners x 60 items (fresh college) | before   | after        | target                                     |
| ----------------------------------------- | -------- | ------------ | ------------------------------------------ |
| whole class, no explanation               | 2,387 ms | **1,109 ms** | <= 800 ms (missed)                         |
| a chunk of 500 learners (grid JSON built) | 1,295 ms | **472 ms**   | <= 300 ms (missed)                         |
| whole class with explanations             | 3,615 ms | 1,486 ms     |                                            |
| lock: approve                             | 4,345 ms | **2,527 ms** | <= 2 s (missed)                            |
| ONE learner (`gradebook_me`)              | 249 ms   | **13.0 ms**  | <= 30 ms, same as at 500 (met: ratio 0.97) |

After `ANALYZE` the numbers are within 5 % of the fresh ones (whole class 421 / 1,051 ms, one learner 12.9 / 11.8 ms).

**What is left, and why the class targets are missed.** About 13 µs per cell: building the cells ~100 ms (500 learners), the sort for drop-lowest
~80 ms, the exact sums and the total ~110 ms, the final ~55 ms, the JSON ~60 ms, the three source reads ~60 ms. Every remaining step is already a
single pass; getting under 300 ms would take a different design (per-learner results kept in a table that triggers update when a mark, a release or
a setting changes, so a read is a select), not more tuning of this statement. A chunk of 500 learners costs the same in a class of 500 and of
1,200, so the grid fills in about 0.5 s per chunk; the lock of a 1,200 learner class is 2.5 s, once.

### Lighthouse of the grid, after the speedups (Step 11b)

The API time was never the reason (the demo college has 3 learners): the grid on the MOBILE preset is 88-89 (LCP 3.1 s, three runs of three, two
sessions: 86-91), as before the speedups. It is the one page measured with the DESKTOP preset (instructors use laptops; the E2E suite keeps checking
the screen with axe at 360 px): **98** performance, 100 accessibility, LCP 0.83 s, TBT 0 ms. The budget of 90 stays for it under that preset
(`frontend/scripts/lighthouse.mjs`, `preset: 'desktop'`, the reason is in a comment there and in ADR 0019).

## Step 11c: planner settings, measured ON and OFF in three statistics states

`bench:gradebook` on a scratch database, as the app role, medians of 3-5 runs. ON = the function-level settings of migration 0042
(`enable_nestloop`, `enable_seqscan`, `enable_mergejoin` = off, `work_mem` 32 MB); OFF = the same functions with the settings removed
(`GRADEBOOK_BENCH_SETTINGS=off`). Three states: (a) a college loaded into a database that has never been analyzed (the bench's FRESH phase on
a newly migrated database); (b) the same college after `ANALYZE` (steady state); (c) a second college loaded after another one was analyzed
(statistics describe a different college; `GRADEBOOK_BENCH_KEEP=1`, and the variant where the first one is deleted). The lock is now measured in
both states of every run.

| 500 learners x 60 items                   | one learner            | whole class | chunk of 500 | lock     |
| ----------------------------------------- | ---------------------- | ----------- | ------------ | -------- |
| (a) no statistics, ON                     | 19.8 (cold) / 12-13 ms | 457 ms      | 477 ms       | 1,043 ms |
| (a) no statistics, OFF                    | 12.4 ms                | 460 ms      | 481 ms       | 972 ms   |
| (b) after ANALYZE, ON                     | 11.8 ms                | 409 ms      | 427 ms       | 1,010 ms |
| (b) after ANALYZE, OFF                    | 12.2 ms                | 456 ms      | 518 ms       | 1,019 ms |
| (c) second college, stats of another, ON  | 12.4 ms                | 421 ms      | 442 ms       | 941 ms   |
| (c) second college, stats of another, OFF | 12.1 ms                | 460 ms      | 482 ms       | 985 ms   |

| 1,200 learners x 60 items | one learner | whole class | chunk of 500 | lock     |
| ------------------------- | ----------- | ----------- | ------------ | -------- |
| (a) no statistics, ON     | 13.4 ms     | 1,020 ms    | 487 ms       | 2,462 ms |
| (a) no statistics, OFF    | 11.9 ms     | 1,166 ms    | 474 ms       | 2,529 ms |
| (b) after ANALYZE, ON     | 10.5 ms     | 932 ms      | 430 ms       | 2,242 ms |
| (b) after ANALYZE, OFF    | 11.9 ms     | 1,102 ms    | 484 ms       | 2,559 ms |

Reading: the settings are neutral in (a) at 500 and 5-17 % faster in every other cell; they are never slower beyond noise (+-3 %).
The catastrophic cases that motivated them (37 s and 47 s) belonged to the first shape of the statement (a join to a `lim` CTE); the
restructured statement is linear without them. One run of the OFF variant (the first one, a database that had just been used by the ON run,
statement timeout 30 s) was cancelled by the timeout in the first compute; five later OFF runs in the same and in fresh databases could not
reproduce it, so it is unexplained. That is the reason to keep them as a safety net as well as a 10 % gain: they cost nothing in any state
and a plan that flips on a college with odd statistics is the failure that matters most for a lock. Nothing was added at the end of the bulk
import / enrolment paths (no `ANALYZE` was needed to make any state fast). The class targets of Step 11b stay missed (see Step 11b).

# Resilience: what is tested, and how to run it (Step 14a)

Design and reasons: [ADR 0024](adr/0024-resilience-and-observability.md). This page is the practical side: the failures we inject, the test
that does it, what it asserts, and the limits of each (what it does NOT prove).

| Failure                                           | Test                                                                       | What it asserts                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL restarts under traffic                 | `test/resilience.postgres.test.ts`                                         | 503 (never 500, 401 or a hang) while down; recovers by itself; readiness reports it; the pool does not leak; every write is complete or absent (membership + audit + outbox)                |
| The database network hangs (no reset, no answer)  | same file                                                                  | the statement deadline cuts it: 503 + Retry-After within seconds, dead connections discarded, recovery                                                                                      |
| A worker is killed mid-job (SIGKILL)              | `test/resilience.worker.test.ts` (serial)                                  | the lease holds, then expires; a second worker takes the job over and finishes it once; attempts = 2; the side-effect file shows A:started, B:started, B:finished                           |
| A worker is stopped under load                    | same file                                                                  | in-flight jobs get the grace period, the rest are released with the attempt refunded, none is left `running`                                                                                |
| The API is shut down under load                   | `test/resilience.shutdown.test.ts`                                         | in-flight requests complete in full; later requests get Fastify's clean 503 or a refused connection; the pool closes; no unhandled rejection                                                |
| The email provider is down (10 minutes simulated) | `core/__tests__/resilience.unit.test.ts` + `test/resilience.email.test.ts` | fewer than 20 provider calls for 300 sends; jobs deferred without charging attempts; nothing dead; the outbox backlog is on the gauge; after recovery every recipient gets exactly one mail |
| Storage errors (ENOSPC, EIO, a hang)              | `test/resilience.storage.test.ts`, unit test                               | upload, confirm and download answer 503 `storage_unavailable` + Retry-After, never 500; nothing logged as an unhandled error; the next request works                                        |
| A hung or failing provider call                   | `core/__tests__/resilience.unit.test.ts`                                   | `withTimeout` cuts at the deadline and drops a late result quietly; the video provider deadline is a `VideoUnavailableError`                                                                |

## The fault-injection proxy

`test/fault-proxy.ts` is a small TCP proxy between the API and PostgreSQL (`dropAll()`, `refuseFor(ms)`, `blackhole()` / `resume()`). It needs
no Docker and no control over the server, so the same test runs on a Windows laptop and in CI. What it does **not** reproduce: a real server
restart's crash recovery (the unlogged rate-limit table is emptied, prepared state is lost), replication lag, or a failover's DNS change. For
those, an **optional extra** run on a scratch cluster is described below; it is not part of the suite.

### Optional: a real `pg_ctl restart` on a scratch cluster

```
initdb -D %TEMP%\lms-scratch -U postgres --auth=trust
pg_ctl -D %TEMP%\lms-scratch -o "-p 5544" start
# create lms_scratch, run `pnpm db:migrate` against it (DATABASE_URL / DATABASE_APP_URL on port 5544), start the API, then:
#   run any traffic generator (loadtest/ in Step 14b), and in another terminal
pg_ctl -D %TEMP%\lms-scratch restart -m fast
# expect: 503s for a few seconds, then 200s; no process exit; `pnpm db:dev:clean` is NOT needed (scratch cluster)
```

Never do this to the development cluster that holds `lms_dev`.

## Running

```
pnpm --filter @lms/backend exec vitest run --project db test/resilience.postgres.test.ts test/resilience.email.test.ts test/resilience.storage.test.ts test/resilience.shutdown.test.ts
pnpm --filter @lms/backend exec vitest run --project serial test/resilience.worker.test.ts       # wall clock: waits for a 3 s lease
pnpm --filter @lms/backend exec vitest run --project unit src/core/__tests__/resilience.unit.test.ts
```

`resilience.worker.test.ts` is in `SERIAL_FILES` (real processes and a lease). The Linux-only SIGTERM test of the API process is
`test/shutdown.test.ts`; Windows cannot deliver SIGTERM to Node, so the graceful path is covered in-process on every OS and by the Linux CI.

## Defects these tests found (all fixed)

1. an **uncaught exception** (process exit) when a connection died while a request held it between two statements;
2. a request that **hung forever** on a connection whose peer vanished (no statement deadline);
3. a database restart answered **500**, not a retryable 503;
4. a storage I/O error reported as "**the file does not exist**" (a learner saw 404 on a file that was there), and a partial resumable video upload
   that could be **truncated** by a transient `stat` failure.

## Operating notes

- **Pool and timeouts**: `DB_POOL_MAX` (10 in production), `DB_QUERY_TIMEOUT_MS` (30 s in the API, none in the worker), the connection timeout
  (5 s default). A saturated pool is 503 `busy`; an unreachable database is 503 `database_unavailable`; both carry `Retry-After`.
- **Email**: `EMAIL_SEND_TIMEOUT_MS`, `EMAIL_BREAKER_FAILURES`, `EMAIL_BREAKER_COOLDOWN_SECONDS`. A circuit that stays open is visible as
  `lms_circuit_breaker_transitions_total{circuit="email:<provider>",to="open"}` and a growing `lms_email_outbox_backlog`; the jobs wait with their
  attempts intact, so nothing needs re-queuing by hand when the provider returns.
- **Cloud Run**: `SHUTDOWN_TIMEOUT_MS` (10 s) must stay above `JOB_SHUTDOWN_GRACE_SECONDS` (8 s); the worker's readiness is on its own port
  (`WORKER_HEALTH_PORT`); `/health/ready` of the API checks the database.

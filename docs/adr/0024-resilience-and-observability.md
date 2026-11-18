# ADR 0024: Resilience and observability (Step 14a)

Status: accepted (Step 14a). SLOs and alerts: `docs/slo.md`. The tests and how to run them: `docs/resilience.md`.

## Observability

### Decision

OpenTelemetry (`core/telemetry.ts`), nothing registered globally except the async-context manager. `installTelemetry()` makes one instance
current; **without one every helper is a no-op** (one null check on the hot path), and tests that do not look pay nothing. It is turned on by
`METRICS_TOKEN` (the metrics endpoint) or `OTEL_EXPORTER_OTLP_ENDPOINT` (traces over OTLP/HTTP; `OTEL_TRACE_SAMPLE_RATIO`, default 10 %,
children follow their parent).

- **Traces: HTTP -> service -> database.** `core/http-telemetry.ts` opens one SERVER span per request in the first hook and runs the rest of the
  request inside its context; `traced()` wraps every async function of every module service in a span `<module>.<function>` (a Proxy applied
  in the composition root, so a new service function is covered without touching it); `db.withTenant` / `withUser` open one `db.transaction`
  span and `withoutTenant` a `db.statement` span (statements inside are not spanned one by one: the round-trip budgets already count them).
  Jobs get a span per run. `test/observability.test.ts` asserts the parent chain. **No attribute may carry personal data**: ids yes, e-mail
  addresses, names, tokens, marks no; a test searches the finished spans for them.
- **Metrics** (Prometheus text, `GET /metrics`, bearer token, 404 when no token is set, strictly rate limited; the worker has the same on its
  own port): HTTP latency histogram and request counter **by route template and status class** (never the raw URL: ids and tokens stay out of
  labels), `lms_db_pool_connections{state}`, `lms_jobs_total` and `lms_job_duration_seconds` per queue and outcome, circuit-breaker
  transitions and rejections, `lms_csp_violations_total`, `lms_legacy_token_verifications_total`, `lms_rate_limit_store_errors_total`, and
  **database-state gauges** read through ONE definer function `lms.ops_metrics()` (counts and ages only: no tenant id, name or payload),
  cached for 5 s so any scrape rate costs at most one statement: job queue depth and **oldest job age per queue**, running and dead jobs, the
  **email outbox backlog** and its oldest age and dead rows, **rollup lag**, the **video processing backlog** and its oldest age.
  The gauges are database-wide: every API instance reports the same number, so aggregate with `max()`, not `sum()`.
- **Worker health** (`core/health-server.ts`, a plain `node:http` server on `WORKER_HEALTH_PORT`, default 3001, 0 = off): `/health/live`,
  `/health/ready` (the database answers and the queue loop did something within `WORKER_READY_MAX_POLL_AGE_SECONDS`; a worker with a job
  running is alive; 503 while stopping) and `/metrics`. A taken port is a warning, not a crash.
- **Logs**: pino JSON with `request_id` as before; the worker's job lines carry `jobId`, `queue` and `attempt`. `test/log-hygiene.test.ts`
  runs login, failed login, reset, invite, hand-in, grading, release and mail delivery at DEBUG level with sentinel values and fails if any
  e-mail address, password, token, mark, feedback or learner text appears in a log line.

## Resilience

### Every external call has a deadline

`withTimeout` (`core/resilience.ts`): the call gets an `AbortSignal`, and the promise rejects at the deadline **even when the library
ignores the signal** (the late result is dropped, never an unhandled rejection).

| Call                                                  | Deadline                                                                | On failure                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| email provider (SMTP, SendGrid)                       | the provider's own (`EMAIL_SEND_TIMEOUT_MS`) + 5 s backstop             | job retried / deferred (below)              |
| storage (every object operation)                      | `STORAGE_OPERATION_TIMEOUT_MS` (30 s; bulk x10; streaming writes: none) | **503 `storage_unavailable`**, Retry-After  |
| video provider (`createUpload/getStatus/deleteAsset`) | `VIDEO_PROVIDER_TIMEOUT_MS` (30 s)                                      | 503 (`VideoUnavailableError`)               |
| database statement (API)                              | `DB_QUERY_TIMEOUT_MS` (30 s; the worker: none)                          | **503 `database_unavailable`**, Retry-After |
| database connection                                   | pool `connectionTimeoutMillis` (unchanged)                              | 503 `busy`                                  |
| ffmpeg                                                | its own hard timeout (Step 7)                                           | the asset fails with a readable reason      |

### A circuit breaker around the email provider

`createCircuitBreaker`: closed, open after `EMAIL_BREAKER_FAILURES` (5) consecutive failures, **refuses calls without making them** for the
cooldown (`EMAIL_BREAKER_COOLDOWN_SECONDS`, 30 s, doubling after a failed trial up to 5 min), then admits **one** trial call (half open).
A permanent refusal (a rejected recipient) is the provider answering: it does not count. When the circuit is open `email.send` throws
`DeferJobError`: the runner calls **`lms.job_defer`** (migration 0055), which puts the job back to `queued` at `now() + delay` with the attempt
**refunded**. So an outage of any length **backs up the outbox and drains it when the provider returns, and never dead-letters mail or
exhausts the workers**: the test simulates 10 minutes at one send every two seconds (300 sends) and the provider is called fewer than 20 times.

### Found by the tests (real defects, fixed)

1. **A dead connection took the process down.** A connection lost while a request held it between two statements emits `'error'` on the
   checked-out client; the pool listens only on idle clients, so the error was uncaught. `inTransaction` now listens, marks the connection
   broken and lets the next statement fail normally (`test/resilience.postgres.test.ts`).
2. **A hung connection held a request forever.** There was no statement deadline; `query_timeout` and TCP keep-alive are set, and a ROLLBACK
   on a dead connection has its own 2 s limit.
3. **A database restart was a 500.** Connection-class errors (SQLSTATE 08xxx, 57P01-03, 53300, socket errors) now answer 503 + Retry-After,
   which is the retryable answer (the SPA retries deadline-sensitive calls on 503 `busy`; other calls show the error and the user retries).
4. **Storage I/O errors looked like "the file does not exist".** The local driver's `catch { return null }` turned EIO / EACCES into a
   missing file (a learner saw 404 on a file that was there), and `writeAt` reopened a partial upload with the truncating flag when a
   `stat` failed. Only ENOENT / ENOTDIR mean missing now; everything else is a clean 503.

### Verified under fault

A TCP **fault-injection proxy** (`test/fault-proxy.ts`: reset every connection, refuse new ones for N seconds, or blackhole) sits between the
API and PostgreSQL. It runs on Windows and in CI with no Docker. The API answers 503, never 500 and never hangs, recovers on its own, the
pool does not leak, and every write is all of its rows or none (each invite is one membership + one audit row + one outbox row). A real
`pg_ctl restart` on a scratch cluster is an optional extra and is not part of the suite. A worker killed with SIGKILL mid-job (real
processes, real runner): the lease expires, a second worker finishes the job once, attempts say 2. The runner stopped under load releases
what did not finish with the attempt refunded. The API shut down under load completes in-flight requests in full.

## Consequences

- The `/metrics` scrape is the only thing that reads `lms.ops_metrics()`; a Prometheus per API instance multiplies nothing (cached).
- `traced()` is a Proxy: a service must not rely on `this` identity of the returned object (none does: they are closures).
- Not done: log-based request tracing across the API and the worker for one user action (the job does not carry the trace id), exemplars,
  and a Grafana dashboard definition (the alert list in `docs/slo.md` is the spec).

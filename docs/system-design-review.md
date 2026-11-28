# Backend system design review (after step 14c)

Date of the review: 2026-11-28. Scope: the backend as it is in the repository after step 14c parts 2 and 3. Method: the route table of the
running app (every route's declarations and hooks), the schema of a migrated database (indexes, column types), probes with malformed input and
rate-limit overruns, the code, and the numbers already in `docs/benchmarks.md`. **No new load measurement was made for this review.**

Each item says what exists, whether it is the same everywhere, the gap, the risk and the recommendation. A gap was fixed only where the fix is
small, low-risk and has a test that failed before it and passes after; everything else is a follow-up (table at the end).

## Fixed during this review

| #   | Gap                                                                                                                                                                                                                                                | Fix                                                                                                                                  | Test (`backend/test/…`)                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| F1  | **A client could choose its own address.** `TRUST_PROXY=true` believed the LEFTMOST `X-Forwarded-For` entry, which the client writes: every per-address limit (sign-in, code checks, strict routes) could be escaped by inventing one per request. | `TRUST_PROXY_HOPS` (1 to 5): only that many entries from the right are believed. Production refuses `TRUST_PROXY=true` without it.   | `design-review.test.ts`, config-doc unit test |
| F2  | The strict (shared) limiter had no deadline: a slow store held a sign-in until the 30 s statement timeout.                                                                                                                                         | 1 s deadline, then per-instance counting (counted in `lms_rate_limit_store_errors_total`).                                           | `design-review.test.ts`                       |
| F3  | The 429 of the forged-cookie limit had no `Retry-After`.                                                                                                                                                                                           | Header added.                                                                                                                        | `design-review.test.ts`                       |
| F4  | No metric told a 429 from any other 4xx.                                                                                                                                                                                                           | `lms_http_rate_limited_total{route}`.                                                                                                | `design-review.test.ts`                       |
| F5  | Nothing failed when a route had no limit tier written down.                                                                                                                                                                                        | The committed table `rate-limit-tiers.txt` is compared with what the app does; public routes on the default limit are a pinned list. | `rate-limit-tiers.test.ts`                    |

**F1 needs a decision at deployment:** the right hop count (Cloud Run alone: 1; behind an external HTTPS load balancer: 2) must be **verified on
the real deployment**. Too small, and every user shares the load balancer's address and is limited together; too large, and spoofing returns.

## 1. Consistency

### Error shape and codes

- **Exists:** one handler (`core/error-handler.ts`) answers `{ error: { code, message, requestId, details? } }`; expected failures are `AppError`
  subclasses (`core/errors.ts`, `<module>.errors.ts`); database/storage outages become 503 with `Retry-After`; unknown errors are 500 with no detail.
- **Consistent:** yes, across modules, including the global limiter's 429 (code `rate_limited`, probed). The tenant fuzz and log-hygiene tests cover it.
- **Gaps:** two classes named `TooManyRequestsError` (`core/errors.ts`, `core/auth-rate-limit.ts`) with different constructors; the SPA's
  `shared/api/errors.ts` still has a friendly text under the old code `FST_ERR_RATE_LIMIT` (it is used by status, so it works).
  There is no single catalogue of codes: a code is a string next to its class.
- **Risk:** low. **Recommendation:** merge the two classes; rename the SPA key; consider a generated code list like `permissions.md`.

### Pagination

- **Exists:** `core/pagination.ts`: keyset over a UUIDv7 id, or over `(created_at, id)` for logs; `limit` clamped to 100. Both cursors have a
  unique tie-breaker. Grids and class views have their own keysets with the same shape.
- **Consistent:** for every list that grows with the college or the platform, except two.
- **Gap:** `GET /platform/account-erasures` and `GET /privacy/erasure-requests` return the newest 100 and no cursor (`hasMore` only on the first):
  older requests cannot be reached. Nested lists inside one offering or one question (outline, extensions, accommodations, regrades, question
  versions) are unpaged and bounded by that parent.
- **Risk:** low now, grows with years of use. **Recommendation:** add the cursor to both lists (the platform function already takes one).

### Ids, timestamps, time zones

- **Exists:** `core/uuid.ts` (`newId`), `lms.uuid_v7()` for rows made inside statements; every column is `timestamptz` (verified in the catalog: no
  naive timestamp, no database-side UUID default); the college's zone for day buckets (`lms.local_day`), `lms_app` pinned to UTC (migration 0058).
- **Consistent:** yes. `test/date-hygiene.unit.test.ts` and `test/local-day.boundary.test.ts` guard it. `gen_random_uuid()` is used only for blind
  grading keys, on purpose.
- **Gap:** none found.

### Idempotency of create / submit / start / approve

All forms disable their button while a request runs (the SPA), which covers a double click but not a retry after a lost response.

| Endpoint(s)                                                                                   | How a repeat is safe                                                                                       |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| exam start / autosave / submit                                                                | one in-progress attempt (partial unique index) resumes; revisions per answer; submit is idempotent         |
| assignment hand-in                                                                            | `request_key` unique per learner: one version                                                              |
| progress heartbeat / viewed / complete                                                        | `seq` per player; upserts                                                                                  |
| gradebook submit / return / approve / unlock; marks; overrides                                | state checked under a row lock; `expected` stale-cell check; unique active override                        |
| assessment release; mark-import and question-import confirm; erasure and reset decisions      | status checked under a row lock (`409` the second time)                                                    |
| data export, college erasure, account erasure, MFA reset                                      | one open request per person (partial unique index)                                                         |
| college, course, offering, academic entities, grade scale, participant, section link, caption | unique constraint (`409`, or upsert)                                                                       |
| invite                                                                                        | one membership per (college, person); an active one is `409`, a pending one is re-invited (another e-mail) |
| accept invite, password reset, MFA enrol / verify / step-up                                   | single-use token or challenge; a TOTP time step is accepted once                                           |
| publish / suspend / archive / reactivate, notification read, unsubscribe                      | state change to a fixed value                                                                              |
| file upload request, video create, import upload, mark-import / question-import stage         | a repeat makes another pending or staged row, which a purge removes                                        |
| assessment regrade                                                                            | a repeat records another run; applying the same key twice changes no score                                 |
| new recovery codes / replace authenticator                                                    | a repeat voids the earlier codes or setup (the person sees only the latest)                                |
| **module create, content item create**                                                        | **nothing: a retry makes a second one**                                                                    |
| **offering copy** (`POST /offerings/:id/copy`)                                                | **nothing: a retry appends everything again** (only a still-running queued copy answers `409`)             |
| **question create, rubric create**                                                            | **nothing: a retry makes a duplicate**                                                                     |
- **Risk:** medium for the copy (a whole course duplicated by one retried request, to be removed by hand), low for the others.
- **Recommendation:** an idempotency key for the copy first (a `request_key` unique per target offering, as `assignment_submit` does); then
  client-chosen ids for module / item / question / rubric creation. Not done here: it changes contracts and the SPA.

### Transaction boundaries

- **Exists:** services open `db.withTenant`; changes and their audit rows are one transaction or one definer function.
- **Consistent:** yes, and enforced: `audit-atomicity.unit.test.ts` (static), `audit-atomicity.test.ts` and the failure-injection tests (including
  every MFA state change), the held-lock race tests, `advisory-locks.unit.test.ts` (transaction-scoped only).
- **Gap:** none found beyond the follow-ups already recorded in `CLAUDE.md`.

### Validation at the edge

- **Exists:** TypeBox on every route; responses are serialised from schemas.
- **Probed:** every route with a path parameter has a `params` schema; calling each college route with the id `not-a-valid-id` produced **no 5xx**.
- **Gap:** about 50 action routes (suspend, approve, publish, …) declare no body schema. Their controllers do not read a body (the type provider
  makes reading an undeclared one a type error), so nothing unvalidated reaches a service. Raw-stream routes (storage PUT, video chunk, CSV upload,
  the webhook) are validated by size, offset, signature or parser instead.
- **Risk:** very low. **Recommendation:** none.

### Authorization

- **Confirmed:** every route declares exactly one of `permission` / `authenticated` / `public`, or the app does not start
  (`route-declarations.test.ts`, `authz-matrix.test.ts`, `offering-scope.test.ts`, `docs/permissions.md`). Step-up routes are pinned
  (`step-up-routes.test.ts`).

## 2. Rate limiting

Every route and its tier: **appendix** (generated from `backend/test/rate-limit-tiers.txt`, which a test keeps true).

| Class                                                                                      | Limit today                                            | Verdict                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| sign-in, MFA codes, forgot, invite accept                                                  | per address and route 10/min, per e-mail 5/min, shared | right against guessing; **too low for a college behind one address** (below) |
| password reset, public unsubscribe, CSP, client errors, webhook, metrics, privacy requests | strict, shared                                         | appropriate                                                                  |
| exam autosave, heartbeat, video chunks and segments, bell, signed storage links            | own numbers, per session                               | appropriate                                                                  |
| everything else (reads and writes)                                                         | 300/min per session (`RATE_LIMIT_MAX`)                 | fine for ordinary calls; **generous for expensive ones**                     |
| health probes                                                                              | none                                                   | right                                                                        |
| `GET /tenant/info` (public)                                                                | default, per address                                   | acceptable (one read); see caching                                           |
- **Keys:** a signed-in request counts against its session (never the address), so a computer lab does not share one budget; anonymous requests
  against the address; forged cookies against the address in a second limiter; auth routes also against a hash of the e-mail. No per-user or
  per-college key exists.
- **Behind a proxy:** fixed as F1. Without `TRUST_PROXY` every request counts against the load balancer.
- **Shared NAT (gap, not fixed: a policy decision):** `RATE_LIMIT_LOGIN_PER_IP` = 10 a minute per route. **A lab of 60 students signing in at the
  start of an exam is limited after the tenth.** Accounts are protected independently (per-e-mail limit, account lockout, MFA counters), so raising
  the per-address number (for example to 120) costs little. **Priority P1, before the first exam.**
- **429 body and header:** one shape, `Retry-After` on every one (F3 was the exception).
- **The PostgreSQL limiter:** local tier decides in memory and syncs in batches; the strict tier is one autocommit statement (measured p50 1 ms,
  p99 6-7 ms, ADR 0022). The table is `UNLOGGED` (empty after a failover, intended). Slow or down: **degrades to per-instance counting** (F2 adds
  the deadline). Is that right per route? Yes for all of them: each protected secret has its own database-side defence (account lockout, MFA
  counters, signature, signed token), so failing closed would only turn a limiter problem into a sign-in outage. The one weaker case is address-only
  endpoints (CSP, client errors), which write nothing.
- **Fairness between colleges (gap):** none. One college (or a script with many sessions) can occupy the API, the database pool and the worker.
  **Recommendation:** a generous per-college ceiling in the local tier, and a per-college cap on concurrent expensive work; measure first.
- **Expensive routes (gap):** gradebook and report exports, the submissions ZIP, offering copy, regrade and dashboards are all at 300/min per
  session. **Recommendation:** their own small limits (about 20/min for exports) and a per-instance concurrency cap for ZIP and XLSX building.

## 3. Caching

### HTTP

| What                                        | Headers today                                                                                                          | Verdict                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API responses                               | `Cache-Control: no-store` unless the route chose otherwise (`core/security.ts`)                                        | right: authenticated data is never stored                                                                                                                                                     |
| exports, downloads                          | `no-store` / `private, no-store`                                                                                       | right                                                                                                                                                                                         |
| the bell                                    | `private, no-cache` + ETag, 304                                                                                        | right: private, always revalidated                                                                                                                                                            |
| SPA assets                                  | hashed: `public, max-age=31536000, immutable`; HTML `no-cache`; `Vary: Accept-Encoding` (`frontend/scripts/serve.mjs`) | right; the production gateway must do the same                                                                                                                                                |
| service worker files                        | `no-cache, no-store, must-revalidate`                                                                                  | right                                                                                                                                                                                         |
| video playlists / segments (local provider) | `private, max-age=60` / `private, max-age=86400`                                                                       | right for development; **`private` means a CDN will not cache**: the managed provider / CDN must set its own, with the signed token kept out of the cache key (signed cookies or URL signing) |
| signed storage links                        | `private, no-store`                                                                                                    | right                                                                                                                                                                                         |

No `Vary: Cookie` is needed because nothing authenticated is cacheable.

### In the application

| Cache                          | Key (what keeps colleges apart)                      | TTL / invalidation                                 | Can it be stale in a way that matters?                                                                             |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| tenant by slug                 | the slug (it IS the college)                         | 60 s; cleared on this instance on suspend / create | a suspended college keeps its public pages up to 60 s elsewhere; **sessions are refused at once** (database check) |
| playback session (local video) | hash of the session token, tenant id, playback token | 60 s                                               | a revoked session keeps **playing** up to 60 s (documented, bounded)                                               |
| course participation           | tenant, user, offering                               | one request                                        | no                                                                                                                 |
| rate-limit counts              | session hash, address, route                         | window                                             | not data                                                                                                           |
| activity "already recorded"    | session                                              | until the local midnight                           | no                                                                                                                 |
| login lockout hint             | user id                                              | per instance, advisory                             | no (the database decides)                                                                                          |
| operations gauges              | none (counts only, no tenant data)                   | 5 s                                                | no                                                                                                                 |

Permissions are **not cached**: every request reads role, membership and tenant status with its session. No cache holds grades.

### Database

Rollups (dashboards, at-risk) are the cache for analytics, with "data as of" shown. Hot reads (class view, gradebook grid, outline,
notifications) are single statements with query-budget tests; no N+1 was found; the planner rules in `CLAUDE.md` have benchmarks.
- **Where a cache would help:** `GET /tenant/info` (public, read on every page load: a 60 s server-side entry keyed by tenant id; **not** a CDN
  cache without the host in the key).
- **Where it would be dangerous:** sessions, roles and permissions (a revoked admin keeps acting), gradebook grid, results and anything a release
  controls (a learner sees an unreleased or outdated mark). **Do not cache these.**

## 4. Resilience and backpressure

- **Deadlines:** API statements 30 s client side (`DB_QUERY_TIMEOUT_MS`); `lms_app` has `statement_timeout` 30 s and
  `idle_in_transaction_session_timeout` 30 s as role defaults (so the **worker** is capped too, whatever its client setting); connection wait 5 s ->
  503 `busy`; storage 30 s, video provider 30 s, email 20 s with a circuit breaker; the strict limiter 1 s (F2).
  **Gap:** no `lock_timeout`: a request waiting for a row lock waits up to 30 s while holding a pool connection.
  **Recommendation (P2):** set it for ordinary requests (for example 5 s) after checking the functions that wait on purpose.
- **Pool:** 10 per instance in production; instances × pool must stay below Cloud SQL `max_connections`.
- **Sizes:** body 1 MB by default; CSP report 8 KB, client errors 4 KB, webhook 2 MB, import 5 MB, file 50 MB, video chunk 8 MB / 2 GB total.
- **Concurrency caps:** argon2 2 at once with a queue of 50 (503 beyond); ffmpeg `video:1`; one import per college; per-queue job concurrency.
  **Gap:** ZIP and XLSX building have none.
- **Jobs:** claimed with `SKIP LOCKED`, lease renewed, exponential backoff with jitter, dead letter after `max_attempts`; a job whose process dies
  is re-claimed, and after its last attempt marked `dead` (so a poison job cannot loop).
- **Shutdown:** API drains then closes the pool, with a forced exit; the worker releases unfinished jobs (`server.ts`, `worker.ts`).
- **Health:** `/health/live` (process), `/health/ready` (database ping); the worker's own port also checks that its loop is alive.
- **Slow or down:** covered by `resilience.{email,postgres,shutdown,storage,worker}.test.ts` and `docs/resilience.md`. The process-kill and
  shutdown tests run on Linux (CI) only. **Gap:** a database that is slow rather than gone is exercised only through the proxy's black hole.

## 5. Observability

- **Logs:** pino JSON with `request_id`, tenant id and user id (an opaque id); no address, password, token, mark or feedback
  (`log-hygiene.test.ts`).
- **Metrics:** requests and latency by route template and status class, 429 by route (F4), pool, job depth / age / dead / duration, outbox,
  rollup lag, video backlog, circuit breaker, limiter store errors, client errors, CSP reports. No id or address in a label.
- **SLOs and alerts:** `docs/slo.md` (targets, not yet measured on GCP).
- **Traces:** HTTP -> service -> transaction. **Gaps:** an incoming `traceparent` (load balancer) is not honoured, and a job does not carry the
  trace of the request that queued it. **Recommendation (P3):** extract W3C context on the way in; store the trace id with the job.
- **Gap:** no alert yet on the new 429 counter (a lab being limited would show there). Add it with the others on GCP.

## 6. Data lifecycle

| Table(s)                                                                                                | Retention today                               | Index for it  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------- |
| sessions, auth tokens, MFA challenges                                                                   | purged (30 d / 30 d / 1 d after the end)      | yes           |
| rate-limit counters                                                                                     | purged every minute; `UNLOGGED`               | yes           |
| jobs                                                                                                    | completed 7 d, dead 30 d                      | yes           |
| e-mail outbox, provider events                                                                          | purged                                        | yes           |
| notifications (members and platform)                                                                    | **read** ones after 90 d; unread never        | yes (members) |
| import rows, question / mark imports, data export archives, upload drafts, unreferenced files and video | purged                                        | yes           |
| `audit_log`, `platform_audit_log`                                                                       | **never** (append-only)                       | list indexes  |
| `attempt_events`, `member_activity_days`, `video_watch_days`                                            | **never**                                     | n/a           |
| `notify_runs`, MFA reset requests, erasure requests, export records                                     | never; a few rows per college per day or less | n/a           |
| gradebook history, submissions, attempts, progress                                                      | never, on purpose (academic record)           | n/a           |
- **Gap:** the three "never" rows in the middle grow with use and hold behaviour data about people. **Risk:** storage, and a data-protection
  question rather than a performance one. **Recommendation:** decide retention with counsel (`docs/legal-questions.md`): audit log (years),
  integrity events (end of the term), activity and watch days (after the usage month is frozen, keeping the aggregates).

## 7. Scalability: 1,500 exam takers and 2,000 video viewers

The only numbers are from a 2-core laptop running the load generator, API, worker and database together (`docs/benchmarks.md`, steps 9, 10 and
14b-2 C). They show service times and some limits; **none of them is a capacity measurement of the target environment.**

| #   | What breaks first                               | Evidence                                                                                                                                                                                                               | Change on GCP                                                                                                                                     |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign-in of a lab behind one address             | the configured limit: 10 a minute per address (the load-test procedure has to raise it to run at all)                                                                                                                  | raise `RATE_LIMIT_LOGIN_PER_IP`; verify `TRUST_PROXY_HOPS`                                                                                        |
| 2   | Video segments through the API (local provider) | 2,000 viewers × a segment every 6 s ≈ 330 requests/s plus several Gbit/s; the harness at 200 viewers sent 2,104 segment requests through the API                                                                       | a CDN and the managed video provider (required anyway: the local provider is refused in production)                                               |
| 3   | Exam start burst                                | 35 to 150 starts/s across runs; 1,500 started in 10 to 43 s, p99 up to 2 s (step 9)                                                                                                                                    | Cloud SQL vCPU first; pre-numbered question candidates if starts still lead                                                                       |
| 4   | Database connections and CPU at a deadline      | 1,500 hand-ins squeezed into 60 s: 503 `busy` retried 1,613 times, whole flow p99 70 s (step 10)                                                                                                                       | more API instances with the pool sized to `max_connections`; a pooler (all session settings are transaction-local); receipts already keep it fair |
| 5   | Password hashing in a login wave                | argon2 runs 2 at a time per instance with a queue of 50 (503 `busy` beyond); one verification took ~13 ms on the laptop, and the harness saw sign-in p50 22 ms at 5/s. A ceiling for a burst has **not been measured** | measure it in the staging run; scale instances ahead of the exam (minimum instances), 2 vCPU or more per instance                                 |

Not a bottleneck at these numbers: autosaves (50/s needed, ~590/s reached before saturation on the laptop), heartbeats (67/s needed for 2,000
viewers, 436/s reached over HTTP). Heavy but not exam-time: whole-class gradebook (1.1 s for 1,200 learners), a full analytics refresh (~77 s).
One transcode runs at a time per worker (`video:1`): uploads queue. E-mail is limited per worker process.

**Read replicas:** reports, dashboards and exports could read from a replica later; nothing that decides access or grades should.
**Workers:** separate worker services per queue (video apart from e-mail) so one cannot starve the other.

Next step: the full-scale run of `docs/load-testing.md` on staging; then confirm or change `docs/slo.md`.

## Follow-ups, by priority

| Priority | Item                                                                                        | Effort   | Risk if ignored                               |
| -------- | ------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| P0       | Verify `TRUST_PROXY_HOPS` on the real deployment (fix F1 is in; the number is not verified) | 0.5 day  | limits bypassed, or everyone limited together |
| P1       | Raise the per-address sign-in limit for colleges behind one address                         | 0.5 day  | an exam where most of a lab cannot sign in    |
| P1       | Full-scale load test on GCP staging; confirm pool, instances, SLOs                          | 3-5 days | capacity unknown                              |
| P1       | CDN and managed video provider (already planned)                                            | GCP step | video cannot go to production                 |
| P1       | Malware scanning of uploads (already on the launch list)                                    | 3-5 days | a hostile file reaches an instructor          |
| P2       | Idempotency key for offering copy                                                           | 1 day    | a duplicated course                           |
| P2       | Lower limits and a concurrency cap for exports and ZIP                                      | 1 day    | one user can occupy an instance               |
| P2       | Per-college fairness ceiling                                                                | 2-3 days | one college slows the others                  |
| P2       | `lock_timeout` for ordinary requests                                                        | 1-2 days | lock waits exhaust the pool                   |
| P2       | Retention for audit log, integrity events, activity and watch days (with counsel)           | 1-2 days | unbounded personal data                       |
| P3       | Idempotent module / item / question / rubric creation                                       | 2 days   | occasional duplicates                         |
| P3       | Cursor for the two erasure lists                                                            | 0.5 day  | old requests unreachable                      |
| P3       | Trace context in and into jobs; alert on the 429 counter                                    | 1 day    | slower diagnosis                              |
| P3       | One `TooManyRequestsError`; rename the SPA's old 429 key; cache `tenant/info`               | 0.5 day  | cosmetic / minor load                         |

## Appendix: every route and its rate-limit tier

`default` = `RATE_LIMIT_MAX` per window (300 a minute) per session, per address when not signed in. The auth tier's numbers are
`RATE_LIMIT_LOGIN_PER_IP` / `_EMAIL`; privacy requests use `DATA_EXPORT_RATE_PER_HOUR`.

```
DELETE /api/academic-years/:id  ->  default
DELETE /api/auth/sessions/:id  ->  default
DELETE /api/batches/:id  ->  default
DELETE /api/departments/:id  ->  default
DELETE /api/email/suppressions/:id  ->  default
DELETE /api/members/:userId  ->  default
DELETE /api/offerings/:id/gradebook/learners/:participantId/override  ->  default
DELETE /api/offerings/:id/items/:itemId  ->  default
DELETE /api/offerings/:id/items/:itemId/assessment/accommodations/:participantId  ->  default
DELETE /api/offerings/:id/items/:itemId/assignment/extensions/:participantId  ->  default
DELETE /api/offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey/penalty-waiver  ->  default
DELETE /api/offerings/:id/items/:itemId/progress/complete  ->  default
DELETE /api/offerings/:id/modules/:moduleId  ->  default
DELETE /api/offerings/:id/participants/:participantId  ->  default
DELETE /api/offerings/:id/sections/:sectionId  ->  default
DELETE /api/offerings/:id/videos/:videoId  ->  default
DELETE /api/offerings/:id/videos/:videoId/captions/:language  ->  default
DELETE /api/platform/email/suppressions/:id  ->  default
DELETE /api/programs/:id  ->  default
DELETE /api/sections/:id  ->  default
DELETE /api/terms/:id  ->  default
GET /api/academic-years  ->  default
GET /api/academic-years/:id  ->  default
GET /api/analytics/settings  ->  default
GET /api/audit  ->  default
GET /api/auth/me  ->  default
GET /api/auth/sessions  ->  default
GET /api/batches  ->  default
GET /api/batches/:id  ->  default
GET /api/courses  ->  default
GET /api/courses/:courseId/question-imports/:importId  ->  default
GET /api/courses/:courseId/question-imports/:importId/rows  ->  default
GET /api/courses/:courseId/question-imports/template.csv  ->  default
GET /api/courses/:courseId/question-tags  ->  default
GET /api/courses/:courseId/questions  ->  default
GET /api/courses/:courseId/questions/:questionId  ->  default
GET /api/courses/:courseId/questions/:questionId/files/:fileId  ->  default
GET /api/courses/:courseId/questions/:questionId/versions  ->  default
GET /api/courses/:courseId/rubrics  ->  default
GET /api/courses/:courseId/rubrics/:rubricId  ->  default
GET /api/courses/:id  ->  default
GET /api/departments  ->  default
GET /api/departments/:id  ->  default
GET /api/email/suppressions  ->  default
GET /api/grade-scales  ->  default
GET /api/gradebook/queue  ->  default
GET /api/gradebook/settings  ->  default
GET /api/health/live  ->  none
GET /api/health/ready  ->  none
GET /api/imports  ->  default
GET /api/imports/:id  ->  default
GET /api/imports/:id/errors.csv  ->  default
GET /api/imports/:id/rows  ->  default
GET /api/imports/templates/faculty.csv  ->  default
GET /api/imports/templates/students.csv  ->  default
GET /api/me/account-erasure  ->  default
GET /api/me/courses  ->  default
GET /api/me/dashboard  ->  default
GET /api/me/data-exports  ->  default
GET /api/me/data-exports/:id/download  ->  default
GET /api/me/email-status  ->  default
GET /api/me/erasure  ->  default
GET /api/me/erasure/preview  ->  default
GET /api/me/mfa  ->  default
GET /api/me/notification-preferences  ->  default
GET /api/me/profile  ->  default
GET /api/me/progress  ->  default
GET /api/me/teaching/dashboard  ->  default
GET /api/members  ->  default
GET /api/members/:userId  ->  default
GET /api/members/:userId/profile  ->  default
GET /api/notifications  ->  default
GET /api/notifications/settings  ->  default
GET /api/notifications/unread-count  ->  custom 240 per 1 minute
GET /api/notifications/unsubscribe  ->  default + strict 120 per 60s per address
GET /api/offerings  ->  default
GET /api/offerings/:id  ->  default
GET /api/offerings/:id/at-risk  ->  default
GET /api/offerings/:id/at-risk.csv  ->  default
GET /api/offerings/:id/at-risk.xlsx  ->  default
GET /api/offerings/:id/attempts/:attemptId  ->  default
GET /api/offerings/:id/attempts/:attemptId/files/:fileId  ->  default
GET /api/offerings/:id/attempts/:attemptId/grading  ->  default
GET /api/offerings/:id/attempts/:attemptId/result  ->  default
GET /api/offerings/:id/copy-preview  ->  default
GET /api/offerings/:id/dashboard  ->  default
GET /api/offerings/:id/gradebook  ->  default
GET /api/offerings/:id/gradebook/export.csv  ->  default
GET /api/offerings/:id/gradebook/export.xlsx  ->  default
GET /api/offerings/:id/gradebook/grid  ->  default
GET /api/offerings/:id/gradebook/learners/:participantId  ->  default
GET /api/offerings/:id/gradebook/mark-imports/:importId  ->  default
GET /api/offerings/:id/gradebook/review  ->  default
GET /api/offerings/:id/items/:itemId  ->  default
GET /api/offerings/:id/items/:itemId/assessment  ->  default
GET /api/offerings/:id/items/:itemId/assessment/accommodations  ->  default
GET /api/offerings/:id/items/:itemId/assessment/analysis  ->  default
GET /api/offerings/:id/items/:itemId/assessment/attempts  ->  default
GET /api/offerings/:id/items/:itemId/assessment/grading/answers  ->  default
GET /api/offerings/:id/items/:itemId/assessment/grading/summary  ->  default
GET /api/offerings/:id/items/:itemId/assessment/me  ->  default
GET /api/offerings/:id/items/:itemId/assessment/preview  ->  default
GET /api/offerings/:id/items/:itemId/assessment/regrades  ->  default
GET /api/offerings/:id/items/:itemId/assignment  ->  default
GET /api/offerings/:id/items/:itemId/assignment/extensions  ->  default
GET /api/offerings/:id/items/:itemId/assignment/files/:fileId  ->  default
GET /api/offerings/:id/items/:itemId/assignment/grading/files/:fileId  ->  default
GET /api/offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey  ->  default
GET /api/offerings/:id/items/:itemId/assignment/grading/queue  ->  default
GET /api/offerings/:id/items/:itemId/assignment/grading/summary  ->  default
GET /api/offerings/:id/items/:itemId/assignment/me  ->  default
GET /api/offerings/:id/items/:itemId/assignment/submissions.zip  ->  default
GET /api/offerings/:id/items/:itemId/download  ->  default
GET /api/offerings/:id/me/grades  ->  default
GET /api/offerings/:id/outline  ->  default
GET /api/offerings/:id/participants  ->  default
GET /api/offerings/:id/progress  ->  default
GET /api/offerings/:id/progress/class  ->  default
GET /api/offerings/:id/progress/class.csv  ->  default
GET /api/offerings/:id/progress/learners/:participantId  ->  default
GET /api/offerings/:id/sections  ->  default
GET /api/offerings/:id/videos/:itemId/engagement  ->  default
GET /api/offerings/:id/videos/:videoId  ->  default
GET /api/offerings/:id/videos/:videoId/upload  ->  default
GET /api/platform/account-erasures  ->  default
GET /api/platform/audit  ->  default
GET /api/platform/email/suppressions  ->  default
GET /api/platform/mfa-resets  ->  default
GET /api/platform/notifications  ->  default
GET /api/platform/tenants  ->  default
GET /api/platform/tenants/:id  ->  default
GET /api/platform/tenants/:id/members  ->  default
GET /api/platform/usage  ->  default
GET /api/platform/usage/export  ->  default
GET /api/privacy/erasure-requests  ->  default
GET /api/programs  ->  default
GET /api/programs/:id  ->  default
GET /api/reports/:table  ->  default
GET /api/reports/:table/export  ->  default
GET /api/reports/active-users  ->  default
GET /api/sections  ->  default
GET /api/sections/:id  ->  default
GET /api/storage/download/:token  ->  custom 120 per 1 minute
GET /api/tenant/info  ->  default
GET /api/terms  ->  default
GET /api/terms/:id  ->  default
GET /api/video/play/:token/:assetId/*  ->  custom 3000 per 1 minute
GET /docs  ->  default
GET /docs/json  ->  default
GET /docs/static/*  ->  default
GET /docs/static/index.html  ->  default
GET /docs/static/swagger-initializer.js  ->  default
GET /docs/yaml  ->  default
GET /health/live  ->  none
GET /health/ready  ->  none
GET /metrics  ->  default + strict 60 per 60s per address
PATCH /api/academic-years/:id  ->  default
PATCH /api/analytics/settings  ->  default
PATCH /api/batches/:id  ->  default
PATCH /api/courses/:courseId/rubrics/:rubricId  ->  default
PATCH /api/courses/:id  ->  default
PATCH /api/departments/:id  ->  default
PATCH /api/grade-scales/:scaleId  ->  default
PATCH /api/gradebook/settings  ->  default
PATCH /api/members/:userId/profile  ->  default
PATCH /api/members/:userId/role  ->  default
PATCH /api/notifications/settings  ->  default
PATCH /api/offerings/:id  ->  default
PATCH /api/offerings/:id/gradebook/settings  ->  default
PATCH /api/offerings/:id/items/:itemId  ->  default
PATCH /api/offerings/:id/modules/:moduleId  ->  default
PATCH /api/offerings/:id/participants/:participantId  ->  default
PATCH /api/offerings/:id/videos/:videoId/upload  ->  custom 1200 per 1 minute
PATCH /api/platform/tenants/:id  ->  default
PATCH /api/programs/:id  ->  default
PATCH /api/sections/:id  ->  default
PATCH /api/tenant/branding  ->  default
PATCH /api/terms/:id  ->  default
POST /api/academic-years  ->  default
POST /api/academic-years/:id/archive  ->  default
POST /api/academic-years/:id/set-current  ->  default
POST /api/academic-years/:id/unarchive  ->  default
POST /api/auth/invites  ->  default
POST /api/auth/invites/accept  ->  default + auth per address
POST /api/auth/login  ->  default + auth per address and e-mail
POST /api/auth/logout  ->  default
POST /api/auth/members/:userId/unlock  ->  default
POST /api/auth/mfa/enrol/confirm  ->  default + auth per address
POST /api/auth/mfa/enrol/start  ->  default + auth per address
POST /api/auth/mfa/verify  ->  default + auth per address
POST /api/auth/password/change  ->  default
POST /api/auth/password/forgot  ->  default + auth per address and e-mail
POST /api/auth/password/reset  ->  default + strict 30 per 60s per address
POST /api/batches  ->  default
POST /api/batches/:id/archive  ->  default
POST /api/batches/:id/unarchive  ->  default
POST /api/client-errors  ->  default + strict 30 per 60s per address
POST /api/courses  ->  default
POST /api/courses/:courseId/files  ->  default
POST /api/courses/:courseId/question-imports  ->  default
POST /api/courses/:courseId/question-imports/:importId/cancel  ->  default
POST /api/courses/:courseId/question-imports/:importId/confirm  ->  default
POST /api/courses/:courseId/questions  ->  default
POST /api/courses/:courseId/questions/:questionId/archive  ->  default
POST /api/courses/:courseId/questions/:questionId/unarchive  ->  default
POST /api/courses/:courseId/rubrics  ->  default
POST /api/csp-report  ->  default + strict 60 per 60s per address
POST /api/departments  ->  default
POST /api/departments/:id/archive  ->  default
POST /api/departments/:id/unarchive  ->  default
POST /api/email/webhooks/:provider  ->  custom 1200 per 1 minute + strict 1200 per 60s per address
POST /api/files/:id/confirm  ->  default
POST /api/grade-scales  ->  default
POST /api/imports  ->  default
POST /api/imports/:id/cancel  ->  default
POST /api/imports/:id/confirm  ->  default
POST /api/me/account-erasure  ->  default + strict 10 per 3600s per address
POST /api/me/data-exports  ->  default + strict 10 per 3600s per address
POST /api/me/erasure  ->  default + strict 10 per 3600s per address
POST /api/me/erasure/cancel  ->  default
POST /api/me/mfa/disable  ->  default
POST /api/me/mfa/recovery-codes  ->  default
POST /api/me/mfa/replace/confirm  ->  default
POST /api/me/mfa/replace/start  ->  default
POST /api/me/mfa/step-up  ->  default + auth per address
POST /api/members/:userId/profile/section  ->  default
POST /api/members/:userId/reactivate  ->  default
POST /api/members/:userId/resend-invite  ->  default
POST /api/members/:userId/suspend  ->  default
POST /api/notifications/:id/read  ->  default
POST /api/notifications/read-all  ->  default
POST /api/notifications/unsubscribe  ->  default + strict 120 per 60s per address
POST /api/notifications/unsubscribe/one-click  ->  default + strict 1200 per 60s per address
POST /api/offerings  ->  default
POST /api/offerings/:id/archive  ->  default
POST /api/offerings/:id/attempts/:attemptId/submit  ->  default
POST /api/offerings/:id/copy  ->  default
POST /api/offerings/:id/files  ->  default
POST /api/offerings/:id/gradebook/approve  ->  default
POST /api/offerings/:id/gradebook/mark-imports  ->  default
POST /api/offerings/:id/gradebook/mark-imports/:importId/apply  ->  default
POST /api/offerings/:id/gradebook/return  ->  default
POST /api/offerings/:id/gradebook/submit  ->  default
POST /api/offerings/:id/gradebook/unlock  ->  default
POST /api/offerings/:id/items/:itemId/assessment/regrade  ->  default
POST /api/offerings/:id/items/:itemId/assessment/release  ->  default
POST /api/offerings/:id/items/:itemId/assignment/files  ->  default
POST /api/offerings/:id/items/:itemId/assignment/files/:fileId/confirm  ->  default
POST /api/offerings/:id/items/:itemId/assignment/release  ->  default
POST /api/offerings/:id/items/:itemId/assignment/submissions  ->  default
POST /api/offerings/:id/items/:itemId/attempts  ->  default
POST /api/offerings/:id/items/:itemId/move  ->  default
POST /api/offerings/:id/items/:itemId/playback  ->  default
POST /api/offerings/:id/items/:itemId/progress/complete  ->  default
POST /api/offerings/:id/items/:itemId/progress/heartbeat  ->  custom 600 per 1 minute
POST /api/offerings/:id/items/:itemId/progress/viewed  ->  default
POST /api/offerings/:id/modules  ->  default
POST /api/offerings/:id/modules/:moduleId/items  ->  default
POST /api/offerings/:id/modules/:moduleId/move  ->  default
POST /api/offerings/:id/participants  ->  default
POST /api/offerings/:id/publish  ->  default
POST /api/offerings/:id/sections  ->  default
POST /api/offerings/:id/unpublish  ->  default
POST /api/offerings/:id/videos  ->  default
POST /api/offerings/:id/videos/:videoId/captions  ->  default
POST /api/offerings/:id/videos/:videoId/complete  ->  default
POST /api/platform/account-erasures  ->  default
POST /api/platform/account-erasures/:id/approve  ->  default
POST /api/platform/account-erasures/:id/cancel  ->  default
POST /api/platform/account-erasures/:id/reject  ->  default
POST /api/platform/mfa-resets  ->  default
POST /api/platform/mfa-resets/:id/approve  ->  default
POST /api/platform/mfa-resets/:id/cancel  ->  default
POST /api/platform/mfa-resets/:id/reject  ->  default
POST /api/platform/notifications/read  ->  default
POST /api/platform/tenants  ->  default
POST /api/platform/tenants/:id/admin-invite  ->  default
POST /api/platform/tenants/:id/reactivate  ->  default
POST /api/platform/tenants/:id/suspend  ->  default
POST /api/privacy/erasure-requests/:id/approve  ->  default
POST /api/privacy/erasure-requests/:id/cancel  ->  default
POST /api/privacy/erasure-requests/:id/reject  ->  default
POST /api/programs  ->  default
POST /api/programs/:id/archive  ->  default
POST /api/programs/:id/unarchive  ->  default
POST /api/sections  ->  default
POST /api/sections/:id/archive  ->  default
POST /api/sections/:id/unarchive  ->  default
POST /api/sections/move  ->  default
POST /api/terms  ->  default
POST /api/terms/:id/archive  ->  default
POST /api/terms/:id/unarchive  ->  default
PUT /api/courses/:courseId/questions/:questionId  ->  default
PUT /api/courses/:courseId/rubrics/:rubricId  ->  default
PUT /api/grade-scales/:scaleId  ->  default
PUT /api/me/notification-preferences  ->  default
PUT /api/offerings/:id/attempts/:attemptId/answers  ->  custom 900 per 1 minute
PUT /api/offerings/:id/attempts/:attemptId/feedback  ->  default
PUT /api/offerings/:id/attempts/:attemptId/questions/:position/grade  ->  default
PUT /api/offerings/:id/gradebook/categories  ->  default
PUT /api/offerings/:id/gradebook/items  ->  default
PUT /api/offerings/:id/gradebook/learners/:participantId/override  ->  default
PUT /api/offerings/:id/gradebook/marks  ->  default
PUT /api/offerings/:id/items/:itemId/assessment  ->  default
PUT /api/offerings/:id/items/:itemId/assessment/accommodations/:participantId  ->  default
PUT /api/offerings/:id/items/:itemId/assessment/slots  ->  default
PUT /api/offerings/:id/items/:itemId/assignment  ->  default
PUT /api/offerings/:id/items/:itemId/assignment/attachments  ->  default
PUT /api/offerings/:id/items/:itemId/assignment/extensions/:participantId  ->  default
PUT /api/offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey/grade  ->  default
PUT /api/offerings/:id/items/:itemId/assignment/grading/learners/:learnerKey/penalty-waiver  ->  default
PUT /api/offerings/:id/items/:itemId/assignment/rubric  ->  default
PUT /api/platform/tenants/:id/email-sender  ->  default
PUT /api/storage/upload/:token  ->  custom 60 per 1 minute
```

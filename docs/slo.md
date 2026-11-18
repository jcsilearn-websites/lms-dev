# Service level objectives and alerts (Step 14a)

What we promise colleges, how we measure it (the metrics of ADR 0024, scraped from `GET /metrics` of the API and the worker's metrics
port), and the alerts to configure on GCP (Cloud Monitoring / Managed Prometheus). The numbers are **targets to adopt after the first load
test on GCP** (Step 14b, `loadtest/`), not measurements: the local benchmarks in `docs/benchmarks.md` are from a 2-core laptop. Review the
targets after the first month of real traffic.

## Windows that matter

A learning platform is not uniformly busy. Availability and latency are judged most strictly in the **critical windows**: an exam in
progress, the hour before an assignment deadline, and the morning login wave. An SLO miss inside a critical window costs a college its
trust; the same miss at 3 a.m. does not. So each SLO has a **standard** objective (all time) and, where it matters, a **critical-window**
objective that pages.

## SLOs

Error budget = 1 - objective, over a rolling 30 days. "Good" = a request that did not answer 5xx **and** was not a 503 `busy` that the client
could not retry through (deadline routes retry by themselves); client errors (4xx) are not failures.

| #   | SLI (what is measured)                                                                                   | Objective (30 d) | Critical-window objective | Source                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | **Availability** of the API: good / total requests, excluding health probes and `/metrics`               | 99.9 %           | 99.95 %                   | `lms_http_requests_total{status_class}`                                                         |
| A2  | **Sign-in** success rate of correct credentials (login 2xx / (2xx + 5xx))                                | 99.9 %           | 99.95 %                   | `lms_http_requests_total{route="/api/auth/login"}`                                              |
| L1  | **p95 latency, read routes** (members list, course outline, my courses, dashboards)                      | < 400 ms         | < 400 ms                  | `lms_http_request_duration_seconds` by route                                                    |
| L2  | **p95 latency, learner exam calls** (start, autosave, submit, my page)                                   | < 300 ms         | < 300 ms                  | same, routes `/api/offerings/:id/.../attempts/*`                                                |
| L3  | **p95 latency, hand-in and upload request** (`assignment_submit`, `.../files`)                           | < 500 ms         | < 800 ms (burst)          | same                                                                                            |
| L4  | **p99 latency, any route except exports, uploads and video segments**                                    | < 2 s            | < 2 s                     | same                                                                                            |
| E1  | **Exam autosave success**: autosaves answered 2xx (or accepted after a 503 retry) / autosaves sent       | 99.95 %          | 99.99 %                   | `lms_http_requests_total` for the autosave route; client queue                                  |
| E2  | **No lost answer**: attempts whose final saved state differs from the learner's last acknowledged answer | 0                | 0                         | integrity check job / support reports (the durable client queue makes this a client-side proof) |
| D1  | **Deadline fairness**: a hand-in or autosave that arrived before the deadline is never judged late       | 100 %            | 100 %                     | `assignment_submit` verdicts; investigated per incident                                         |
| J1  | **Job freshness**: oldest due job per queue (`email.send`, `video`, `courses.sync`, imports, analytics)  | < 5 min          | < 2 min (`email.send`)    | `lms_job_queue_oldest_age_seconds{queue}`                                                       |
| M1  | **Email timeliness**: a security email (reset, invite) is handed to the provider within                  | 2 min (p99)      | 2 min                     | outbox age, `lms_email_outbox_oldest_age_seconds`                                               |
| R1  | **Data freshness** of dashboards: rollup lag                                                             | < 15 min         | < 15 min                  | `lms_rollup_lag_seconds`                                                                        |
| V1  | **Video processing**: oldest asset in processing                                                         | < 60 min         | n/a                       | `lms_video_oldest_age_seconds`                                                                  |

**What is deliberately not promised:** video segment latency (the CDN's), the speed of exports, imports and ZIPs (they stream and are
measured in throughput), the delivery of email to the recipient's mailbox (the provider's and the recipient's), and anything about a
college's own network.

## Recovery objectives (targets; the mechanism is Step 14b)

RPO 5 minutes and RTO 1 hour with Cloud SQL point-in-time recovery; see `docs/step-14b-notes.md`. The shared rate limiter's table and the
video session cache are deliberately non-durable.

## Alerts to configure on GCP

**Pages** (a person is woken, one of these means a critical window is at risk):

| Alert                         | Condition                                                                                              | Why / first look                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| API error burn, fast          | 5xx ratio > 14.4 x budget over 5 min AND over 1 h (A1)                                                 | multiwindow burn rate: 2 % of the monthly budget in an hour |
| API error burn, slow          | 5xx ratio > 6 x budget over 30 min AND over 6 h                                                        | slow bleed                                                  |
| **Database unavailable**      | `/health/ready` failing for > 1 min on any instance OR `database_unavailable` 503s > 5 % for 2 min     | the 503 path of Step 14a; check Cloud SQL, then the pool    |
| **DB pool starving**          | `lms_db_pool_connections{state="waiting"}` > 0 for 2 min                                               | saturation before `busy` 503s; raise `DB_POOL_MAX` or scale |
| **Exam autosave failing**     | autosave 5xx or 503 ratio > 0.5 % for 2 min (E1)                                                       | the most expensive failure: learners are in a timed exam    |
| **Deadline burst under load** | 503 `busy` ratio > 2 % for 3 min on `assignments`/`attempts` routes                                    | receipts protect fairness; still a capacity signal          |
| Worker dead                   | `lms_job_queue_oldest_age_seconds{queue="email.send"}` > 10 min OR any queue > 30 min                  | the worker is down or wedged; readiness on its port         |
| Email outbox stuck            | `lms_email_outbox_backlog{status="queued"}` rising and oldest age > 10 min while the circuit is closed | provider problem or a bug                                   |

**Tickets** (a person looks within the working day):

| Alert                                        | Condition                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| p95 latency regression (L1-L4)               | over objective for 30 min                                                                                                                       |
| Circuit breaker opened                       | `increase(lms_circuit_breaker_transitions_total{to="open"}[15m]) > 0`, with the circuit name                                                    |
| Dead jobs or dead emails                     | `lms_jobs_dead` or `lms_email_outbox_dead` increasing                                                                                           |
| Rollup lag                                   | `lms_rollup_lag_seconds` > 30 min                                                                                                               |
| Video backlog                                | `lms_video_oldest_age_seconds` > 60 min                                                                                                         |
| Rate-limit store failing                     | `increase(lms_rate_limit_store_errors_total[10m]) > 0` (limits degrade to per instance)                                                         |
| **CSP violations after a deploy**            | `increase(lms_csp_violations_total[1h])` above the pre-deploy baseline: the policy blocked something the app now needs, or an injection attempt |
| **Legacy token use** (until the flag is off) | `lms_legacy_token_verifications_total` rising after the removal date; flat zero for a week before it                                            |
| Certificate / DNS / quota notices            | platform alerts: Cloud Run revision failures, Cloud SQL storage > 80 %, CPU > 80 % for 15 min                                                   |

**Dashboards** (one page each): API (request rate, error ratio, latency by route, pool), Jobs (depth, oldest age, outcomes and duration per
queue, dead), Email (backlog, age, circuit state), Learning-critical (autosave and hand-in rates and latency, 503 busy, deadline receipts),
Security (login failures, 429s, CSP violations, strict-limit hits).

## Notes for the metrics

- Aggregate the database-state gauges (`lms_job_queue_*`, `lms_email_outbox_*`, `lms_rollup_lag_seconds`, `lms_video_*`) with **`max by (...)`**:
  every API instance reports the same database-wide value.
- Latency histograms use the buckets 5 ms - 10 s; compute percentiles with `histogram_quantile` over a 5-minute rate, by route template.
- Labels carry **route templates, queue names and status classes only**: never an id, an address, a college or a person. A per-college view
  needs the college's host in the load balancer's log, not in a metric label (cardinality and privacy).
- `OTEL_TRACE_SAMPLE_RATIO` defaults to 10 %: raise it for an incident, not permanently.

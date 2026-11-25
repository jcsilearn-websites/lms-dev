# Load testing (step 14b, part C)

A harness that sends the six load shapes of a college day through the REAL API: the same cookies, CSRF headers, signed upload URLs, resumable video and
deadline receipts the browser uses. It is plain Node with [undici](https://github.com/nodejs/undici) in `loadtest/`. **The full-scale run happens later on GCP**;
this page says how to run it, and `docs/benchmarks.md` ("Step 14b-2 part C") has what a reduced run on the development laptop measured.

## Why plain Node and not k6

k6 was checked first (the plan said "k6 if it can be installed"). It is **not installed** on the development machine and the machine has no package manager that can fetch it
(`winget` and `choco` are absent); a release binary could be downloaded by hand. We chose Node and undici anyway, for reasons that outlive that check:

- the scenarios need what the product already is: cookie sessions with a CSRF rule, a two-step signed upload to another origin, an HLS player with heartbeats, an exam
  client with a revision counter and a deadline-receipt retry. In JavaScript with Node's own `fetch`-class stack they are a few lines each; k6 scripts run in a Go
  JavaScript engine without Node's modules, so none of the repository's helpers or contract knowledge could be shared and each flow would be written twice;
- the seeding (argon2 hashes, set-based SQL, an ffmpeg clip) is Node already; one language, one lockfile, one CI job;
- the harness is **unit-tested** (statistics, arrival curves, the guard, the HLS parser: `pnpm loadtest:test`), which a k6 script cannot be without a second runner;
- the cost is real: a Node generator is heavier per virtual user than k6's Go. The harness measures its own health (event-loop delay and how late it started each task) and
  **declares itself saturated** when that grows, instead of letting a slow generator make the server look fast. Past a few thousand users per machine, run it from several
  machines (below).

## Layout

```
loadtest/
  package.json        @lms/loadtest (the only direct dependency: undici, pinned exactly)
  src/seed.mjs        a throwaway college: people and structure in SQL, content through the real API, a video
  src/run.mjs         runs scenarios, prints a table per scenario, writes one JSON file per scenario
  src/scenarios/      login-wave, exam, assignment, video, grading, browsing (+ common.mjs)
  src/client.mjs      one simulated user: cookie jar, CSRF headers, Host header, latency per route template, 503 busy retry
  src/stats.mjs       exact percentiles, bounded memory, per-route status counts, the verdicts
  src/schedule.mjs    seeded randomness, arrival curves, an open-model launcher that measures its own lag, pacing loops
  src/guard.mjs       the allowlist: where load may be sent
  src/hls.mjs         the little of HLS a viewer needs
  scripts/smoke.mjs   all six scenarios at a tiny scale on the E2E stack (the harness's own end-to-end test)
  scripts/local-run.mjs   a reduced-scale run on the local stack (the numbers of docs/benchmarks.md)
  test/               node --test: stats, schedule, guard, HLS, config
  .state/  results/   git-ignored: the seed state (holds the password of the throwaway accounts), the result files
```

```
pnpm loadtest:test                  the unit tests (no server, no database)
pnpm loadtest:smoke                 tiny scale, real stack: seed + six scenarios, fails when a scenario's flow or its results are wrong (E2E_SKIP_BUILD=1 reuses frontend/dist)
pnpm loadtest:local -- --scale 0.1 --time-scale 0.1        a reduced run on the local stack, results in loadtest/results/
pnpm loadtest:seed -- --api <url> --host <college host> --learners 1500        seed a throwaway college on any ALLOWED environment
pnpm loadtest:run  -- --state <slug> --scenario all --scale 1 --enforce        run against it
```

## The guard: where load may go

A load test is a denial of service against whatever answers. Both the seed and the runner **refuse**:

- `NODE_ENV=production` in their own environment;
- any API or database host that is not on the allowlist. The default allowlist is this machine: `localhost`, `127.0.0.1`, `::1` and `*.localhost`. A staging environment is
  added by naming it: `LOADTEST_ALLOWED_HOSTS=staging.example.org,*.stage.example.org` (exact names or `*.suffix`; the bare suffix is not included). **A production host is never put there.**
  There is no flag that turns the check off, and no other variable is consulted (`loadtest/test/guard-hls-client.test.mjs`);
- (seed only) a slug that does not start with `bench-lt-`, so a real-looking college cannot be created, and a slug that already exists. On a development database
  `pnpm db:dev:clean --yes --project-ref local` still removes the `bench-%` colleges.

## The seed

`node loadtest/src/seed.mjs --api http://127.0.0.1:3100 --host bench-lt-ab12.localhost:3100 --learners 1500 --instructors 8` (environment: `LOADTEST_DATABASE_URL`, else `DATABASE_URL`: the OWNER connection of
the target database).

- **People and structure go straight into the database** in one transaction (an administrator, instructors, learners, a year, a term, a course, a published offering, every
  participation). All accounts share ONE argon2id hash of one password with the application's own parameters, so a sign-in costs what a real one costs and is never rehashed.
- **Content goes through the real API** as a real instructor sign-in: a module, 8 readings, a question bank of 40, an exam of 30 questions (20 attempts allowed, so a college can be
  re-tested 20 times), an assignment (files and text, resubmission allowed, so a second run is a new version), and a video: an ffmpeg test clip (default 120 s) uploaded through the
  resumable API and transcoded by the worker. Without ffmpeg or a running worker the video is skipped and the video scenario says so.
- It writes `loadtest/.state/<slug>.json` (git-ignored; owner-readable): the ids and the password. Copy it to every generator machine.
- It does not clean up. On a development database use `db:dev:clean`; **a staging database is disposable**: recreate it or restore its snapshot.

## The six scenarios

All of them sign their users in first (the PREPARATION phase, at most `--login-rate` a second, recorded apart and kept out of the results) and then run an OPEN model: every
arrival happens at its planned moment whether or not the server keeps up, and the lateness of each start is recorded.

| #   | Scenario     | What the users do                                                                                                                                                                                                 | Full-scale shape                                                              |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `login-wave` | sign in in a rush (triangular curve, peak at 30 % of the window), then `/auth/me`, the learner dashboard, my courses, the bell                                                                                    | 1,500 learners in 5 min                                                       |
| 2   | `exam`       | start (spread over a window), read the paper, autosave 3 answers every ~30 s with the revision counter, then **everybody hands in inside the last minute**; some read their result                                | 1,500 learners, a 60-minute exam, starts within 2 min                         |
| 3   | `assignment` | the instructor sets a due date; learners hand in with an arrival curve that grows towards it (density t squared): page, upload request, PUT of a 2 MB file to the signed URL, confirm, hand in; a few arrive late | 1,500 learners in 10 min, 2 MB PDFs                                           |
| 4   | `video`      | playback session, master and variant playlists (renditions 20 / 30 / 50 % for 360p / 480p / 720p), the init segment, one segment per segment duration at real speed, a heartbeat every 30 s                       | 2,000 viewers, ramp 5 min, 10 min each                                        |
| 5   | `grading`    | instructors page through the queue from different places, open a learner, think, save a grade; sometimes the summary and the gradebook grid. Missing hand-ins are made first (unmeasured)                         | 20 instructors, 15 min, think time 8 s                                        |
| 6   | `browsing`   | dashboard, my courses, the outline, a reading, my progress, "viewed", the bell on its own 60 s timer, with think time                                                                                             | 1,000 learners, 10 min. `--with-browsing N` runs it behind any other scenario |

`--scale` multiplies the number of people, `--time-scale` the WINDOWS, `--cadence-scale` the per-person cadences (autosave, heartbeat, think time, bell). **A reduced run that keeps full
scale's arrival rates gives `--scale` and `--time-scale` the same value and leaves the cadences at 1.** A user who autosaves twenty times as often is a different load, not a faster
test (the smoke run does shrink them: it measures nothing).

### What a run reports

One table per scenario (count, rate, mean, p50, p90, p95, p99, max, failures, status codes per ROUTE TEMPLATE: ids and tokens are never part of a label), a JSON file with the same
numbers, the configuration, the preparation figures and these verdicts:

- **server errors and transport failures**: 5xx and requests that got no answer, against `--max-error-rate` (default 1 %). A 503 `busy` that the client retries through is counted once as
  the 503 it was;
- **the generator kept its schedule**: how late tasks started (p95 under 1 s) plus the event-loop delay. When this fails the message says `GENERATOR SATURATED`: **the numbers of that run
  are not valid**, run it from a stronger machine or split it.

`--enforce` turns a failed verdict into exit code 1. Compare latencies with the objectives of `docs/slo.md` (L1 reads 400 ms p95, L2 exam calls 300 ms, L3 hand-in 500 ms / 800 ms in the burst,
L4 any route 2 s p99): they are targets to adopt after the first GCP run.

## The reduced run on a laptop

`E2E_SKIP_BUILD=1 pnpm loadtest:local -- --scale 0.1 --time-scale 0.1` starts the E2E stack (API, worker, `lms_e2e` on the local PostgreSQL 17, relaxed rate limits), seeds a college,
runs all scenarios one after the other and stops the stack. The generator, API, worker and database share one machine, so the numbers describe THAT machine only.

## The full-scale procedure on GCP

Do this on a **staging** environment built like production (same Cloud Run sizes and limits, same Cloud SQL tier, the CDN and the managed video provider once they exist). Never on production.

1. **Allow the host.** On every generator machine: `export LOADTEST_ALLOWED_HOSTS=<staging API host>,<college host>` (the college host is `<slug>.<APP_BASE_DOMAIN>` of staging).
2. **Raise the limits that a single address would hit**, for the test window only, as environment variables of the staging API (and note them in the run's record):
   `RATE_LIMIT_LOGIN_PER_IP` (a lab's worth of sign-ins from one generator address; the per-email limit stays), `RATE_LIMIT_MAX` (per session, normally unaffected), and
   `DATA_EXPORT_RATE_PER_HOUR` is irrelevant. With several generator addresses the per-address limit is spread; the strict limiter lives in PostgreSQL, so its cost shows in Cloud SQL.
   `TRUST_PROXY=true` must be on (`docs/production-config.md`) or all generators count as the load balancer's one address.
3. **Seed.** Through the Cloud SQL Auth Proxy with the owner role, from a machine on the allowlist (the database host is `127.0.0.1` through the proxy):
   `LOADTEST_DATABASE_URL=postgresql://<owner>:<pw>@127.0.0.1:5432/<staging db> DB_SSL=off node loadtest/src/seed.mjs --api https://<staging API host> --host <slug>.<domain> --slug bench-lt-<tag> --learners 2000 --instructors 20`
   (`DB_SSL=off` is accepted because the connection to the proxy is local). The video needs ffmpeg on the seeding machine; with the managed provider the upload goes through its own
   path and the seed's video step must be adapted when that provider exists.
4. **Generators.** One machine per ~1,000 simulated users is a safe start (Compute Engine, same region as the staging environment, 4 vCPU; use `--connections 1024`). Each machine takes a
   **disjoint range of learners**: `--learner-offset 0`, `--learner-offset 1000`, ... with `--learners 1000` (and the same state file copied to each). Start the machines together
   (the windows are relative to each machine's start; a shared `at` or a scheduled job does it); the results are one file per machine and scenario, add the counts and take the
   WORST p95 / p99 of the machines, never their average.
5. **Run order** (one at a time, so each is attributable): `login-wave`, `exam`, `assignment`, `video`, `grading`, then `exam --with-browsing 1000` and `assignment --with-browsing 1000` for the mix.
   Command: `node loadtest/src/run.mjs --state bench-lt-<tag> --scenario exam --scale 1 --time-scale 1 --learners 1000 --learner-offset 0 --enforce`.
6. **Watch while it runs** (the dashboards and alerts of `docs/slo.md`): Cloud Run instance count and request latency, Cloud SQL CPU, connections and lock waits, `/metrics`
   (`lms_job_queue_oldest_age_seconds`, `lms_rollup_lag_seconds`, `lms_http_request_duration_seconds` by route), the worker's queue, the storage bucket's request rate, the CDN's hit ratio. A scenario that fails
   its verdicts is a finding: record the numbers, the instance counts and the Cloud SQL graphs together.
7. **Record** the results in `docs/benchmarks.md` under a "GCP load test" heading: the date, the commit, the environment (sizes, limits raised), per scenario the table of the worst machine, the
   verdicts, and the Cloud SQL / Cloud Run observations. Then confirm or change the targets of `docs/slo.md`.
8. **Clean up.** The seeded college is not removed by any script on staging: recreate or restore the staging database, and delete the generator machines and `loadtest/.state/` (it holds the throwaway password).

## Not covered

- Real browsers: the harness speaks HTTP, so it does not measure the SPA's bundle, rendering or the service worker (Lighthouse and the E2E suite do).
- Video from a CDN or a managed provider: with the local provider the API serves segments, which is what the scenario measures; with a CDN the segment requests leave the API and the
  scenario then measures the playback-session and heartbeat load of the API only.
- Mail: the e-mail outbox is the worker's, measured by `bench:notifications`.
- Exports, ZIPs and imports: throughput benchmarks of their own (`docs/benchmarks.md`).

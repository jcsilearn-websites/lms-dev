# ADR 0020: Dashboards, rollups, at-risk learners and usage metering (Step 12)

Status: accepted (Step 12). Builds on [ADR 0016](0016-learning-progress.md) (watched ranges), [ADR 0017](0017-assessments.md),
[ADR 0018](0018-assignments.md), [ADR 0019](0019-gradebook.md) and the job queue of [ADR 0010](0010-job-queue-bulk-import-academics.md).
Numbers: `docs/benchmarks.md` (Step 12).

## Context

Instructors, administrators and the platform operator need numbers: what is due, who is behind, how a course is doing, what a college
used this month. Three constraints shape every choice: a page load must never run a heavy aggregate (target <= 200 ms of database time);
the numbers about PEOPLE must be explainable and visible only to the staff of that offering; and the numbers that become an INVOICE must not
move once the month is closed.

## Decision

### The college time zone

`tenant_settings` key `timezone` (IANA, default `Asia/Kolkata`, validated against `pg_timezone_names` and audited with before and after).
Every day / week / month bucket is a LOCAL day (`lms.local_day`); timestamps stay UTC. The next midnight is computed by converting
midnight, never by adding 24 h (`lms.next_local_midnight`: DST days are 23 or 25 hours; tested for Asia/Kolkata (+05:30) and
America/New_York). A zone change affects FUTURE buckets only: days already written keep the day they were written with (history is not
rewritten).

### Activity: one row per user and local day

`member_activity_days (tenant, user, day)`. The API remembers per SESSION "recorded until the next local midnight" and writes after the
response (`onResponse` hook): at most one idempotent upsert per user and day, never per request, never on the request path. Polling
(`/auth/me`), health and media segment requests do not count as a person being active. After a restart or on another instance the cost of a
miss is one `ON CONFLICT DO NOTHING`, so correctness never depends on the cache. No page views are tracked.

### Rollups: marks, recompute, never deltas

Tables (all RLS, read-only for the app, written by definer functions): `rollup_learner_offering` (per learner and offering),
`rollup_offering_day`, `rollup_org_day` (department / program / batch / section), `rollup_tenant_day`, `rollup_state` (watermark and
"data as of").

- **Change marks, not scans.** Triggers on the source tables write a mark (`rollup_dirty_participants` / `rollup_dirty_offerings`) in the SAME
  transaction as the change, so a change cannot be lost. An offering-wide change (items, deadlines, settings) is one offering mark, expanded to
  its learners by the refresh. The source tables get no new index; the mark is a HOT update of a tiny table.
- **Recompute from the source.** A refresh recomputes the affected keys and upserts; it never applies a delta, so it is idempotent and
  order-independent (property test: random mutations, random partial refreshes, then equality with a direct computation written independently
  in TypeScript; and a second refresh changes nothing). It deletes only the marks it saw (same `marked_at`), so a change that lands meanwhile
  stays marked.
- **No lock cycle with edits (step 12b).** The `pnpm lighthouse` stack hit a `deadlock detected` once: a content edit held its offering
  `FOR UPDATE` (the access CTE) and waited for the offering's change mark, while the refresh held that mark (it had just deleted it) and its
  insert into `rollup_offering_day` waited for the offering in the foreign-key check (`FOR KEY SHARE`, which `FOR UPDATE` blocks). Either side
  can be the victim, so an instructor's edit could have failed. The access CTE now locks `FOR NO KEY UPDATE`: edits of one offering are still
  serialised against each other, FK checks no longer wait (no locked statement deletes an offering or changes its key). Regression test in
  `test/analytics.rollup.test.ts` (it fails with the old lock).
- **The clock is also a source.** A due date passing, an item opening, an item becoming overdue changes a number with no row change: the run
  marks the offerings whose boundaries lie between the last run and now (tested: a deadline that passes changes the row at the next refresh).
- **Bounded.** `ANALYTICS_ROLLUP_BATCH` learners per statement; a scheduled system job (`analytics.rollup`, slot-keyed, any number of workers).
- **"Data as of"** is the run time when nothing is waiting, else the age of the oldest unapplied change.
- Live and small stays live: the grading backlog of one offering, the video drop-off, the evidence of a flagged learner.

### At-risk learners: rules and evidence, never a score

Four rules over the learner rollup, thresholds per college (`tenant_settings` key `atRisk`, defaults in `lms.atrisk_settings`): behind on
required items (the offering's own `behind_after_days`), missed >= 2 deadlines, average of RELEASED scores below the pass mark (a college
setting, 40 %), no activity for 14 days (counted from enrolment when there is none). The flags are evaluated when read, so a changed threshold
applies at once. A flagged learner is shown with the rules that fired and the evidence (which items, which dates, which scores), computed live
for the page shown. There is no risk score, no ranking and no number that combines rules. Visible only through `atrisk.view`: instructors and
assistants by participation in THAT offering, institution admins; never a learner (tested against every learner-facing response);
administrators' dashboards show counts per department, no names. Exports (CSV, XLSX) carry the same rules and evidence.

### Dashboards and reports

Learner: one definer call about the caller only (upcoming deadlines, quiz windows and items opening; released grades by name; where to
continue; this week; a private streak). Instructor: per offering and across their offerings. Administrator: one generic report table
(`columns`, `rows`, a summary sentence, `asOf`) used for the screen, the accessible table and the CSV / XLSX export of EVERY table, capped at
100,000 rows.

**"Needs attention" (course health)** is a list of running OFFERINGS, for institution administrators only (`report.view`: instructors, assistants
and learners get 403, also for the export). It sits behind a college setting `showCourseHealth` (default ON, audited with before and after);
switched off, the report and its export answer 404 `report_disabled` and the dashboard simply leaves the block out. Each row carries the REASON
in plain words: "No new content in N weeks" (setting `courseHealthWeeks`, default 3) and/or "Grading backlog older than D days" (setting
`courseHealthBacklogDays`, default 14: the oldest ungraded hand-in or attempt of the offering). It names courses and counts, never a person: no
instructor, no learner, no ratio per teacher, and the sentence above the table says it is about the upkeep of a course, not about any person.
It is a prompt for a conversation, not a performance metric, and a college that disagrees can turn it off.

### Usage metering

- **Video watched** is the sum of the NEW unique seconds `progress_heartbeat` accepts, written to `video_watch_days` inside the same definer
  call (the heartbeat stays 2 round trips). `item_progress` alone cannot say "this month": it only holds the cumulative total.
- **Billable learner** = active on at least N local days of the month (default 1) and (default) a learner of at least one offering; both are
  college settings and the definition used is stored in the snapshot.
- **Estimated GB delivered** = watched seconds x bytes per second of the video, weighted by an ASSUMED rendition mix
  (`USAGE_RENDITION_MIX`, default 360p 20 % / 480p 30 % / 720p 50 %). Bytes per second of a rendition = the bytes measured at transcode /
  duration. Renditions a video does not have (it is never upscaled) drop out and the rest is re-weighted. GB is decimal (10^9).
- **Storage** = ready files + video outputs + video sources not yet purged, measured when the month closes.
- **Monthly snapshots** (`usage_snapshots`) are written once per college and local month, two hours after the month ends in the college's own
  zone, by a scheduled job (`ON CONFLICT DO NOTHING`); a trigger refuses UPDATE and DELETE for everyone including the owner; a correction is
  a new revision with a reason (the table supports it; no endpoint writes one yet). The open month is computed live and marked provisional.
  The platform sees AGGREGATES only (no person, no course).

### Accuracy limits (say these to a college that asks)

1. **Video GB is an estimate.** Players choose renditions adaptively and the server does not see which; the mix is an assumption. The error is
   bounded by the spread of the rendition bitrates (a 720p minute costs several times a 360p minute) and is largest for a college whose
   viewers are all on one rendition. It is not a CDN bill.
2. **Hours are unique seconds**, the integrity-checked claim of `progress_heartbeat` (a forged client can claim up to the bucket). Re-watching
   adds nothing, so hours understate time on screen, and a viewing that is never reported (a closed tab between heartbeats) is lost.
3. **Activity is "an authenticated request that is not a poll"**: an open tab that sends real requests counts; a person who only reads a page
   loaded earlier does not. A learner counts as billable from one request.
4. **A day keeps the zone and the group it was written with** (a zone change or a section move does not rewrite history).
5. **Storage is a month-end gauge**, not a month average; shared (copied) files are counted once.
6. A rollup can lag by `ANALYTICS_ROLLUP_SECONDS` plus the backlog; every screen says "data as of".

## Consequences

- A new source of a dashboard number needs a mark (trigger), a recompute branch and a line in the independent reference of
  `analytics.rollup.test.ts`: the property test fails otherwise.
- The heartbeat gained one upsert when seconds are accepted (measured: still one definer call, 2 round trips).
- Planner lessons of this step (docs/benchmarks.md): an aggregation per day instead of a correlated count; a SQL function with a `SET`
  clause is not inlined; `OFFSET 0` keeps a settings lookup out of a row filter; `jit = off` for these functions; `enable_nestloop = off`
  only where measured neutral.

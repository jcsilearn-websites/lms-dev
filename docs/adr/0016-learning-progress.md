# ADR 0016: Learning progress (Step 8)

Status: accepted (Step 8). Builds on [ADR 0013](0013-courses-content-storage.md) (courses, content) and
[ADR 0015](0015-video.md) (the player events this step consumes).

## Context

Learners need to see where they are in a course and to resume; instructors, assistants and administrators need to see the class.
For video the question is "how much of it was really watched", not "how far did the slider get". The same facts must hold when a
learner uses several tabs and devices, goes offline, or tries to cheat, without a request per second hitting the database.

## Decision

### What is stored

- `item_progress`, one row per (participant, item), with composite foreign keys to the participant, offering and item, all
  `ON DELETE RESTRICT` (history is never deleted; the Step 6b rule). The application can only **read** it; every write is a
  hardened `SECURITY DEFINER` function (`progress_heartbeat`, `progress_mark`), as for the job queue and the credentials.
- **Video: the unique seconds played, as a PostgreSQL 17 `int4multirange`** of whole seconds. The union (`+`), difference (`-`)
  and intersection (`*`) of multiranges are exactly the questions asked: merge what was just watched into what was watched,
  find what of it is new, cut it to the video. No interval-merging code in the application, and the column stays small (a
  1-hour video watched completely is `{[0,3600)}`). Whole seconds, end exclusive: a second counts only when it was played
  completely; seeking forward adds nothing because a seek closes the played range on the client.
- Completion rules per item: `manual` (Mark as done), `on_view` (opening it, a validated client call), `watch` (a video: at
  least `course_offerings.completion_threshold` percent, default 90, range 50 - 100). Defaults: text manual, file and link on
  view, video watch. Items are required (default) or optional. Completion is **sticky**: a learner who completed an item stays
  completed when the instructor raises the threshold, replaces the video or makes it longer (the history is not rewritten).
- A course's progress = completed required items / required items the learner can see (published, module published, open, not
  archived). A module without a required item has no percentage (null), never 0 or 100.
- **Archive instead of delete.** An item or module with progress is soft-deleted (`deleted_at`): gone from outlines, percentages
  and the builder, progress and files kept; without progress it is deleted for good. The builder says which ("This item has
  learner progress, so it will be archived"), from the editors-only `hasProgress` flag of the outline. Archived items keep their
  video reference, so such a video cannot be deleted (409) while history points at it.

### The heartbeat protocol (the integrity story)

The client sends, every 30 s while playing and on pause, seek, end and page hide: the video, a random id per player instance
(`streamId`), a number per stream (`seq`), the ranges played since the last heartbeat, the position and the speed.

- **One call, one round trip**: the API checks the session (1 statement) and calls `lms.progress_heartbeat` on an autocommit
  connection (2 round trips in all; the budget was 3). The function re-checks everything the outline checks, through the one rule
  `lms.learner_item_access` (a parity test compares it with the outline for every combination): only an active learner of a
  published offering who can see the item records progress. Non-participants get 404, instructors and assistants 403 (a preview
  creates no learner progress), a learner who cannot see the item 404.
- **A claim is cut, not rejected.** A token bucket per learner and item (refills at 2x real time, cap 10 minutes, starts at 45 s)
  limits how many NEW seconds can be claimed; the surplus is cut (the earliest seconds are kept) and counted in `suspicious`,
  shown to instructors as "flagged heartbeats", never as an error to the learner. Two tabs or devices share the bucket and the
  union, so they cannot inflate the time; the bucket is large enough that heartbeats queued while offline arrive late without
  being cut. Ranges are cut to `[0, duration)`; a claim fragmented beyond 500 ranges is refused (and counted), the history is kept.
- **Order and duplicates.** A `seq` not higher than the last of the same stream is a duplicate (nothing changes, the answer says
  so). The position is last-writer across streams (the newest player wins: "resume on any device").
- **Honest limit.** A client that forges ranges can claim up to the bucket (about 2x real time) of video it did not watch. A web
  page cannot prove that someone watched; the design bounds the claim and flags it, nothing more. No DRM (ADR 0015).
- **Page hide** uses `fetch` with `keepalive: true`, not `sendBeacon`: every POST needs `X-Requested-With` (CSRF) and a beacon
  cannot send headers (tested: the request without them is refused). The client keeps an in-memory queue, retries with a growing
  delay, merges a long backlog (the request in flight is never touched), and stops quietly on 401 / 403 / 404 (409
  `video_changed` tells the page the video was replaced). A request killed by the page unloading is lost; the next one carries
  on from its own ranges.
- **Replacing a video** keeps the rows and recomputes coverage against the new duration at the next heartbeat; an old player gets
  409 `video_changed`. A completed learner stays completed.

### Reads

- Learner: `GET /offerings/:id/progress` (per item and module) and `GET /me/progress` (every course and where to continue).
- Class: `GET /offerings/:id/progress/class` (learners x modules, filters section / status / removed, sort, keyset),
  `.../class.csv` (streamed page by page, formula-injection safe: `core/csv.ts`, shared with the imports) and
  `.../learners/:participantId`. Instructors and assistants (by participation) and administrators (`progress.view_class`, read
  only). Learners never see others. Removed learners are hidden by default, with a filter for their read-only history.
- Status: completed > behind > not started > in progress. **Behind** = a required visible item open longer than
  `behind_after_days` (1 - 60, default 7, per offering) and not completed, counted from the later of the item's creation and its
  opening date.
- **Percentages are aggregated from the rows, not kept in counters**; measured in
  [docs/benchmarks.md](../benchmarks.md#percentages-aggregation-or-counters-decision): 47 ms against 6 ms for a page of 100 of
  500 x 100, but a counter has to be repaired for every learner whenever the denominator changes, including when time passes an
  item's opening date, and costs +15 % on every completion.

### Planner discipline (found by the benchmark)

The class statement and the access rule are written so that every plan is linear without statistics (a college just loaded): one
row per learner before any join, the page before its module shares, `MATERIALIZED` for steps that must run once, unique-key
lookups in `LATERAL ... OFFSET 0` (migration 0027). Before this the class view took 340 - 1,000 ms and every heartbeat read the
whole class. `pnpm --filter @lms/backend run bench:progress` is the regression check.

## Consequences

- The player events of Step 7 now have a consumer; the player emits them unchanged.
- Progress is read-mostly from the application's point of view: its role has SELECT only, which keeps "who may write progress"
  in one reviewed place in the database.
- Not built: notifications to "behind" learners, per-item deadlines, grades (later steps), a per-learner export beyond the class
  CSV, a shared rate limiter for heartbeats (the limiter is per instance, like the others).

# ADR 0013: Courses, offerings, participation, content and file storage (Step 6)

Status: accepted (Step 6). Builds on ADR 0004 (account roles + course participation), 0010 (job queue) and 0012 (frontend).

## Decisions

**Domain.** `courses` (catalog entry; the department is OPTIONAL because colleges run cross-department electives and skill
courses) -> `course_offerings` (a course in a term, optional label, status draft | published | archived) ->
`offering_sections` (which sections' students are enrolled) and `course_participants` (instructor | assistant | learner,
one row per member per offering, `source` manual | section). A course cannot be archived while an offering is not; an
offering cannot be created under an archived course or term (database triggers, 409 `has_active_children` /
`parent_archived`). `origin = 'platform_copy'` and `source_ref` are reserved for a future platform catalog.

**Participation is resolved per offering, inside the statement that does the work.** Every `scope: 'offering'` route only
needs a session at the route hook; the service puts an access CTE (`acc`) into the SAME statement as the change, which
answers visible / allowed from the caller's participation: not visible -> **404** (a non-participant never learns the
offering exists), visible but lacking the permission -> **403**. That keeps every endpoint at 4 round trips (session lookup
- BEGIN + one fused statement + COMMIT) and removes the check-then-act gap. `CourseParticipationResolver` (core) is the
  contract for code that needs the answer outside such a statement. A test probes every `scope: 'offering'` route with a
  non-participant (404) and with participants whose part lacks the permission (403).

**Enrolment through sections is a trigger-driven, incremental sync.** Statement-level triggers (transition tables) on
`member_profiles` and `tenant_memberships` record WHICH members changed in `course_sync_pending` (the primary key is the
dedupe) and queue ONE `courses.sync` job per college **only while none is queued** (a running job does not suppress the
next one, so a change made during a run is never lost). The job takes members in batches of 200; each batch deletes the
pending rows it took and applies them in one transaction (`FOR UPDATE SKIP LOCKED`, picked once in a MATERIALIZED CTE: as
a plain IN-subquery the planner re-ran the LIMIT pick and took more rows than asked). The cost is proportional to the
changes (docs/benchmarks.md). Manual participants are never touched; an administrator's removal is sticky
(`removed_reason = 'manual'`); archived offerings are frozen. Participants are history: memberships are soft-removed (Step 6b), never deleted, and the participant rows are kept.

**Content** is `content_modules` and `content_items` (text | file | link | video; **video is in the schema, the API refuses
to create it until Step 7**). Order is a fractional key (`position text COLLATE "C"`, base 62, never ending in 0,
`lms.position_between`): moving an entry rewrites ONE row; unique constraints plus a retry make concurrent inserts safe.
Rich text is **validated JSON, never HTML**: the server accepts only the editor's vocabulary (paragraph, heading 2-3, bold,
italic, code, blockquote, lists, links with http/https/mailto), rebuilds the tree, and the browser renders it with its own
React renderer (no `dangerouslySetInnerHTML` anywhere). A learner gets published entries only; an entry that is not open
yet is sent as title + `availableFrom` with no body, link or file. The whole learner outline is ONE statement.

**Copying content** between offerings is one set-based statement; copies are unpublished drafts, and **copied items share
the file rows**. Up to 500 items it runs in the request, above that as the `content.copy` job (idempotent: a retry after
success copies nothing; the offering shows `copyStatus`).

**Files.** `core/storage` defines `StorageProvider`: signed expiring upload and download URLs. The local driver
(development only; **refused when NODE_ENV=production**) serves HMAC-signed URLs from `/api/storage/*` (rate limited;
uploads keep the CSRF checks and a Content-Length precheck answering 413 before a byte is read); the GCS driver is a stub
that answers 503. The server decides the type: extension allowlist + magic bytes (a PNG called .pdf is refused and
removed), the size limit at request, at the URL and at confirm, SHA-256 recorded. Only PDF, PNG and JPEG are served inline;
everything else is an attachment, always with `nosniff` and `Content-Security-Policy: sandbox`.
`POST /files/:id/confirm` costs **7 round trips** (a documented exception): two short transactions with the storage read
in between, so no database transaction is held while bytes are hashed. The orphan purge deletes a file only when NOTHING
references it AND it is older than `FILE_PURGE_GRACE_HOURS` (default 24) counted from the later of the upload confirmation
and the last time a reference was removed (a confirmed but not yet attached file survives). Rows go first (a foreign key
protects a file that just got a reference), objects second.

**Frontend.** The builder is its own lazy route (dnd-kit); the rich-text editor (Tiptap) is a further chunk, prefetched in
idle time once the builder has loaded and **never reachable from the sign-in, learner or administrator screens**
(`scripts/check-bundle-size.mjs` fails otherwise). Every drag has a button equivalent and an announcement for screen readers.

## Consequences

- A new `scope: 'offering'` route needs an access CTE in its statement, a row in the authorization matrix and a body in
  `offering-scope.test.ts`.
- Ids of rows created inside the sync, the copy and the trigger-queued jobs come from `lms.uuid_v7()` (Step 6b).
- Malware scanning of uploads before a file becomes `ready` is NOT built (see the GCP TODO in CLAUDE.md).
- Tiptap is pinned to 3.31.4: 3.32.1 was inside the repository's minimum-release-age window when it was added.

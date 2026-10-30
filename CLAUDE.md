# JCS iLearn LMS — engineering guide (read this first)

Production multi-tenant SaaS LMS sold to multiple colleges. This is a commercial product, not a demo.
Steps 1 (foundation), 1b (module-based restructure), 2 (authentication + tenant resolution), 2b (round-trip
budget + cleanup jobs), 4 (permission system + member and tenant management), 5 (academic structure, member
profiles, bulk CSV import, Postgres job queue), 5b (the frontend for all of them) and 6 (courses, offerings,
participation, course content, file storage; backend + frontend), 6b (soft removal, PostgreSQL 17 everywhere) and 7 (video
lessons behind provider interfaces; backend + frontend) are built. Do not build features beyond the current step without
being asked.

## Architecture (decided — do not change without asking the owner)

- **Modular monolith**, two pnpm workspace packages: `backend/` (API + worker + DB code, one codebase) and
  `frontend/` (React SPA). No Turborepo. See `docs/adr/`.
- Backend: Node 24 LTS + Fastify 5. Frontend: React + Vite + TanStack Query + TanStack Router + Tailwind (ADR 0012).
- Database: PostgreSQL, **shared schema**, every tenant-owned table has `tenant_id`, enforced by
  **Row-Level Security** (enabled AND forced). **PostgreSQL 17 everywhere** (local, CI, Cloud SQL; ADR 0014): the code refuses any other major.
- ORM: Drizzle (typed queries). **Migrations are hand-written SQL files** (`backend/migrations`); each module's
  `<module>.model.ts` mirrors its tables and `backend/test/schema-drift.test.ts` fails on drift.
- Validation: TypeBox schemas on **every route, request AND response** (fast-json-stringify + OpenAPI).
- IDs: UUIDv7 generated in the app (`newId()` in `core/uuid.ts`), not by the DB. Rows created INSIDE a statement (sync, copy,
  queued jobs, set-based audit rows) use `lms.uuid_v7()` (migration 0020, portable plpgsql RFC 9562; never native `uuidv7()` /
  `gen_random_uuid()` for ids). Timestamps: `timestamptz`, UTC.
- Deploy target later: Google Cloud Run + Cloud SQL (asia-south1). Stateless, 12-factor, config only
  from env vars, graceful shutdown on SIGTERM.
- Dev and test DB: **PostgreSQL 17 installed natively on the developer machine (localhost:5432)**, no Docker (ADR 0011;
  Supabase is no longer used, ADR 0006 is superseded). Dev = database `lms_dev`; tests = one database per Vitest worker
  `lms_test_1 ... _N` derived from the `TEST_DATABASE_URL` base name (`lms_test`). The cluster needs the roles `anon` and
  `authenticated` (CI creates them too, so migrations behave the same everywhere): `pnpm db:local:setup`.
  Standard `pg` driver, our own roles and policies only (no third-party auth / storage / realtime / data API).

## Repo layout

```
/  package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json  .dependency-cruiser.cjs
   CLAUDE.md  README.md  .env.example  .github/  docs/
backend/
  src/
    server.ts       API entrypoint (start, warm DB pool, graceful shutdown)
    worker.ts       worker entrypoint (startWorker + main; runs handlers from the modules)
    app.ts          builds the Fastify app: wires plugins + every module's routes
    core/authz/     permission catalog, role maps, can(), route-declaration hook, generated-docs renderer
    composition.ts  composition root: plain factories wiring repos -> services -> controllers/handlers
    config/         env validation, SSL options, logger config, secret redaction
    db/             pools/client, withTenant, migration runner, seed, lms schema namespace
    core/           AppError classes + central error handler, request-id, security plugins,
                    OpenAPI, pagination helpers, uuid, tenant log binding, job-handler types
    contracts/      shared TypeBox schemas + types exported to the frontend (leaf folder)
    core/storage/   StorageProvider (local signed-URL driver, GCS stub), file types + magic bytes
    core/video/     VideoProvider (local = ffmpeg + HLS served by the API; gcp / bunny stubs), playback tokens, ffmpeg/ffprobe runner
    modules/<module>/   health, tenants (+tenant_settings), users, memberships, audit, sessions, auth,
                        jobs (queue), academics, profiles, imports, courses, content, files, video
  migrations/       numbered SQL files
  test/             global setup, DB reset, guards, shared helpers, cross-cutting DB tests
  bench/            autocannon benchmark
frontend/src/
  app/              app shell, root layout (branding, 404 college), providers, router (one route tree per host kind), theme
  features/<feature>/  auth, tenant, dashboard, members, academics, imports, audit, settings, me, platform, courses, video:
                       <feature>.api.ts (typed with backend contracts), pages, hooks
  shared/           ui/ (button, field, select, dialog, data-table, toast, states), api/ (client, errors), forms/, utils/
frontend/e2e/       Playwright specs + helpers   frontend/scripts/  stack, e2e, serve, bundle check, lighthouse, screenshots
frontend/test/      component tests (Vitest + Testing Library + MSW, typed with the contracts)
```

The frontend imports the backend **only** through `@lms/backend/contracts` (the `./contracts` subpath export in
`backend/package.json` → `backend/src/contracts/`). Use `import type` for contract types so no backend
runtime code lands in the browser bundle. This is enforced by dependency-cruiser.

## Frontend rules (step 5b)

- **Imports from the backend**: only `import type` from `@lms/backend/contracts` in code that loads at start-up (the
  shell, `api` modules, hooks). A VALUE import (the TypeBox schemas) belongs in lazy chunks only (route components, the
  lazily loaded `auth.validators.ts`): it pulls TypeBox + all contracts (19 KB gzip) into whatever imports it.
- **One origin, `/api`**: every API route is registered under `/api` (`API_PREFIX` in `app.ts`; the health probes are also at
  the root; `/docs` stays at the root). The browser calls `/api/...`; the dev server / `scripts/serve.mjs` / the Cloud Load
  Balancer forward `/api/*` to the API with NO rewrite and untouched Host, Origin and Cookie. A new route needs no prefix in its
  `routes.ts` (the prefix is applied at registration); tests use `TestClient`, which adds it. `changeOrigin: false` and the `127.0.0.1` target in
  `vite.config.ts` are load-bearing (see the comments there). Production: README "Production routing".
- **UI hiding is cosmetic.** `usePermissions()` (from `/auth/me`) decides what is shown; the API enforces everything.
- **Every data screen** has a skeleton, an empty state and an error state with a retry; destructive actions use
  `ConfirmDialog` and NAME the target; mutations toast and update the TanStack Query cache in place (`setQueryData` /
  patch the cached pages), they do not refetch whole lists. Lists are keyset "load more". Cascading pickers
  (department -> program -> batch -> section) fetch a level only after its parent is chosen, every options request is
  bounded (`limit=100`); never fetch all sections of a college.
- **Forms**: public auth forms use `useSimpleForm` + the lazy validator; everything else react-hook-form + `typeboxResolver`
  (pass `labels` so messages use the words of the form). TypeBox does not know the `uuid` / `date` formats unless they are
  registered (`shared/forms/validation.ts` does).
- **Accessibility (WCAG 2.1 AA)**: real labels, `role="alert"` errors linked with `aria-describedby`, native `<dialog>`,
  visible focus, touch targets >= 44 px on phones, colours only through the tokens in `index.css` (contrast of every pair is a
  unit test). The college colour is applied per theme only where it passes AA (`shared/utils/color.ts`).
- **Budgets** (CI): login page initial JS <= 125 KB gzip, any route <= 150 KB (`pnpm bundle:check`); Lighthouse mobile
  performance >= 90 and accessibility >= 95 on the login page and the members list (`pnpm lighthouse`).

## Layer responsibilities (per module, in `backend/src/modules/<module>/`)

| File                     | Responsibility                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<module>.routes.ts`     | URL + method + TypeBox schemas + preHandlers. **No logic.** May import only its controller, schemas and `core/`.                                                            |
| `<module>.controller.ts` | Reads the validated request, calls the service, maps the result to the response DTO. **No DB access, no business rules.**                                                   |
| `<module>.service.ts`    | Business rules and workflows. **Owns transaction boundaries** (opens `db.withTenant` or a transaction). Calls its own repository and _other modules' public services_ only. |
| `<module>.repository.ts` | SQL only (Drizzle). Every function receives the transaction (`Executor`) from the service. Explicit column selection, keyset pagination, no business rules.                 |
| `<module>.handlers.ts`   | Background-job and domain-event handlers for this module (run by the worker). They call the module's service — never a second HTTP layer, never the repository.             |
| `<module>.schemas.ts`    | TypeBox request/response schemas for the module's routes.                                                                                                                   |
| `<module>.model.ts`      | Drizzle table definitions owned by this module (`lms` namespace from `db/lms-schema.ts`).                                                                                   |
| `<module>.errors.ts`     | Module-specific `AppError` subclasses with stable error codes.                                                                                                              |
| `index.ts`               | Public interface: **the only file other modules (and the composition root) may import.**                                                                                    |
| `__tests__/`             | Unit tests (`*.unit.test.ts`: service with a fake repository, no DB) + API tests (`inject()` + real test DB).                                                               |

Wiring: plain factory functions with explicit dependencies (`createUsersService({ db, usersRepo, auditService })`).
No DI framework, no decorators, no classes except error classes. Everything is wired in `composition.ts` (shared)
and `app.ts` / `worker.ts`.

### Checklist: adding a new module `foo`

1. `mkdir backend/src/modules/foo` with all of: `foo.routes.ts`, `foo.controller.ts`, `foo.service.ts`,
   `foo.repository.ts`, `foo.handlers.ts`, `foo.schemas.ts`, `foo.model.ts`, `foo.errors.ts`, `index.ts`,
   `__tests__/` (a handlers stub with a comment is fine).
2. Tables: new numbered SQL migration (RLS enabled + forced, `tenant_id`, composite FKs, policies `TO lms_app`,
   least-privilege grants) **and** the Drizzle definition in `foo.model.ts`. Add the model to
   `backend/test/schema-drift.test.ts` and the table to the lists in `policies.test.ts` / `tenant-isolation.test.ts`.
3. Repository functions take `(tx: Executor, …)`; list queries are keyset-paginated via `core/pagination.ts`.
4. Service opens `db.withTenant(...)`; throw errors from `foo.errors.ts` (extend `NotFoundError`, `ConflictError`, …).
5. Export factories/types/errors from `index.ts`; wire in `composition.ts`; register routes in `app.ts`.
6. Contracts the frontend needs go in `backend/src/contracts/` (not in the module).
7. Tests: service unit test with a fake repository + API test with `inject()`; run `pnpm lint` (layering rules).

## Enforced layering (dependency-cruiser, runs in `pnpm lint` and CI)

Config: `.dependency-cruiser.cjs`. These rules **fail the build**:
- routes may import only their controller, schemas and `core/`
- controller must not import repository, model, `db/`, `drizzle-orm` or `pg`
- repository must not import service, controller or routes
- a module may import another module (and `app.ts`/`composition.ts` may import a module) **only via its `index.ts`**
- `core/` must not import `modules/` or `db/`; `db/` must not import `modules/`; `contracts/` imports nothing else from backend
- nothing in backend imports from frontend; frontend imports backend only via `@lms/backend/contracts`
- no circular dependencies

Test files (`__tests__/`, `backend/test/`, `backend/bench/`) are exempt from the layering rules (they may reach
into internals) but still count for the no-circular rule.

## Roles and authorization model

Exactly three account roles:
- **Platform Admin**: `users.is_platform_admin boolean default false`. Not a tenant member by default.
  Every action a platform admin takes inside a tenant MUST be written to `audit_log`
  (actor, tenant, action, target, timestamp). (Enforcement path is built in the auth step.)
- **Institution Admin / Member**: `tenant_memberships.role` enum with exactly `'institution_admin' | 'member'`.
  Students, faculty and teaching assistants are all `member`.
- **Identity**: one global `users` table + `tenant_memberships` (a person can belong to many colleges).
- **`profile_type` (student / faculty / staff) is a LABEL, never a permission.** It is for display, filtering and
  reports. A member whose profile says `faculty` can do exactly what any other `member` can; an institution admin
  whose profile says `student` is still an admin. Permissions come ONLY from the account role and course
  participation (tested: `profiles.test.ts`). Never branch on `profile_type` to allow or deny anything.
- **Course-level capability** (a LATER step; no course tables yet) comes from a course participation
  type: `'instructor' | 'assistant' | 'learner'`.
- **Authorization is always checked via permission names** (`'course.edit'`, `'submission.grade'`),
  **never by comparing role strings in route code or in services.** See "Authorization (step 4)".
- Membership status is `active | pending | suspended | removed`. Only `active` members can sign in or keep a session.
- **Academic history is never deleted (step 6b).** A membership is NEVER hard-deleted by the app (`lms_app` has no DELETE on
  `tenant_memberships`): `DELETE /members/:userId` is a SOFT removal (`status = 'removed'`, sessions revoked, the sync closes the
  member's course participations with `removed_reason = 'membership'`). Inviting the same person again brings the SAME membership
  back (pending, then active on accept) and the sync restores the participations. **Tables that hold academic history
  (participation, submissions, attempts, grades, profiles) never cascade from memberships or users: their foreign keys are
  `ON DELETE RESTRICT` and they use soft states** (`status`, `removed_reason`). Only ephemeral rows (sessions, invite tokens)
  may cascade. Member lists hide removed members unless `status=removed` is asked for; an import never touches a removed member.
- **Planned extension (NOT built):** `course.create` is institution-admin-only because faculty and students are both
  `member`. If a college needs faculty to create courses, add a per-membership capability flag (e.g.
  `can_create_courses`) rather than a fourth account role.

## Authorization (step 4)

Full tables (who can do what, every route's declaration): **`docs/permissions.md`, generated** by
`pnpm docs:permissions` from the code. A test (`permissions-doc.unit.test.ts`) and CI (`pnpm docs:permissions --check`)
fail when the committed file is stale: regenerate and commit it whenever permissions or routes change.
- **Where**: `core/authz/` (not a module: it is pure, has no DB and `core/` must not import modules). `catalog.ts` is the
  typed permission union grouped by area, `roles.ts` the role -> permission maps, `policy.ts` is `can(subject, permission,
  resource?)`: **deny by default**, pure and synchronous, O(1) Set lookups, zero queries for account-level checks. A
  course-scoped permission is granted only by `resource.participation`, which the caller resolves through a
  `CourseParticipationResolver` (interface in `core/authz/resolver.ts`, per OFFERING; the courses module implements it:
  one indexed query, cached per request via `forRequest()`) and passes in. A resource of another tenant is never allowed.
- **Every route MUST declare exactly one** of `config: { permission: 'x' }` (or an array = any of them),
  `config: { authenticated: true }` or `config: { public: true }`. `registerRoutePolicy` (an `onRoute` hook) makes the
  app refuse to start otherwise and installs the check as the first route-level `onRequest` hook: it runs right after the
  session is resolved and **before body validation**, so an unauthorised caller gets 401/403, never a validation error.
- **Services re-check resource-level permissions themselves** ("can this user grade THIS submission", "is this member in
  my tenant"). Route checks are coarse; **services are the source of truth** and call `can(ctx, ...)` with the
  `RequestContext`. Never compare role strings.
- **`GET /auth/me` returns `permissions`** (the caller's account-level permission names). The frontend uses them to show or
  hide navigation and buttons; that is cosmetic only, the backend checks every request.
- **Roles**: `platform_admin` (admin host only), `institution_admin` and `member` (tenant host); course participation
  `instructor | assistant | learner`. An institution admin has read-only `content.view` on every course of the college plus
  `report.view`, and **no** `course.edit/publish`, `assessment.create`, `submission.grade`, `grade.finalize` unless they
  participate in that course. `course.create` is institution-admin-only.
- **Hosts**: a session belongs to one host. A platform admin cannot act on a tenant host and tenant users cannot act on
  the admin host (their cookie is ignored -> 401). Platform permissions are never granted on a tenant host (-> 403 for a
  signed-in tenant user). The only cross-tenant access is the audited read `GET /platform/tenants/:id/members`
  (`auditService.withPlatformAdminAccess` writes the tenant `audit_log` AND `platform_audit_log` in the same transaction).
- **Audit entries carry the actor**: `GET /audit` and `GET /platform/audit` return `actorName` / `actorEmail` next to `actorUserId`,
  from the same query (a LEFT JOIN on `users` under RLS; the platform log through `platform_list_audit_v2`). An actor who can no
  longer be read (removed from the college) is "Unknown user"; a platform admin acting inside a college is "Platform administrator";
  a system action has no actor (null). Budgets unchanged.
- **College branding** (`tenant_settings` key `branding`: display name + primary colour `#rrggbb`): public `GET /tenant/info`
  (response is EXACTLY `{slug, displayName, primaryColor}`, pinned by a test; rate limited like every route), `PATCH /tenant/branding`
  (`tenant.manage`, audited with before/after).
- **Tests**: `authz-matrix.test.ts` (every endpoint x caller -> expected status; it is the spec), `route-declarations.test.ts`,
  `core/__tests__/authz-policy.unit.test.ts`. A new route needs a row in the matrix.

### Member and tenant management (step 4)

- **Members** (`/members...`, tenant host): list (keyset on the membership id, filters role/status, `q` = email or name
  prefix), get, change role, suspend / reactivate, SOFT-remove the MEMBERSHIP (status `removed`; the global user and the history are kept), resend invite.
  Role change and suspension revoke that user's sessions in the tenant; every change is audited with before/after.
  An admin cannot demote, suspend or remove themselves (409 `cannot_modify_self`).
- **Last-admin invariant lives in the database** (trigger `guard_last_admin`, migration 0008): a transaction that would
  leave a tenant with no ACTIVE `institution_admin` fails (409 `last_admin`). It takes `pg_advisory_xact_lock(tenant)`,
  so concurrent demotions serialise. The table OWNER is exempt (cleanup / migrations); `lms_app` is not (tested). A new
  tenant may have no active admin until the first invite is accepted.
- **Search** uses tenant-scoped, trigger-maintained keys on `tenant_memberships` (`search_name`, `search_email`, indexed
  `(tenant_id, key text_pattern_ops)`), not global indexes on `users` (measured: docs/benchmarks.md, step 4). `core/search.ts`
  `prefixPattern()` escapes LIKE wildcards: never build a pattern by hand.
- **Mutations are ONE statement** (data-modifying CTEs: lock + update + `auth_revoke_user_sessions` + audit insert).
  The audit module owns the table, so other modules' repositories fold it in with `auditInsertFrom` (audit index).
- **Platform admin** (`/platform/...`, admin host): create college (+ first admin invite in the same transaction), list,
  get, rename (slug immutable, also by trigger), suspend / reactivate (effective at once for sessions: `auth_lookup_session`
  checks the tenant status; the slug cache is cleared on this instance, other instances catch up within `TENANT_CACHE_TTL_MS`),
  `admin-invite` (invite, or promote an existing ACTIVE member: their sessions in that college are revoked and they get a notification email), audit log. They use the hardened `platform_*` SECURITY
  DEFINER functions (migration 0009), which re-check that the actor is a platform admin.
- The tenants module has a second service/repository for this audience (`tenants.platform.*`).

## Job queue (step 5)

Postgres table `lms.jobs` claimed with `FOR UPDATE SKIP LOCKED` (module `jobs`); pg-boss was rejected because it owns
its own schema (no RLS / hand-written migrations / tenant column) - see ADR 0010.
- **Enqueue in the business transaction**: `jobsService.enqueue(tx, { queue, tenantId, payload, ... })` (or a set-based
  `INSERT INTO lms.jobs ... SELECT` in the same CTE) - if the write rolls back, the job never existed. Tenant jobs are
  plain INSERTs under RLS (own tenant only); system jobs (`tenant_id` NULL) go through `job_enqueue_system`.
  After the commit of a set-based insert call `jobsService.notifyEnqueued(queue)`.
- **The worker has no tenant context**, so claim / complete / fail / extend-lease / release / purge are hardened
  SECURITY DEFINER functions (`job_*`; `lms_app` has SELECT + INSERT only). Every function only acts while the caller
  still holds the lease (`locked_by`).
- **Handlers** live in `<module>.handlers.ts`; the handler NAME is the queue name; `run(payload, ctx)` gets
  `ctx.tenantId`, `attempt`, `maxAttempts` and `ctx.signal` (aborted on shutdown / lost lease: a long handler checks it
  between batches). Services open the transaction: a tenant job's handler passes `ctx.tenantId` to its service, which
  uses `db.withTenant`.
- **Retries**: exponential backoff with jitter (`JOB_BACKOFF_BASE_SECONDS`, capped), `max_attempts`, then state `dead`
  (dead letter, kept `JOBS_DEAD_RETENTION_DAYS`; completed jobs `JOBS_COMPLETED_RETENTION_DAYS`; `jobs.purge`).
- **Leases**: a running job renews its lease every third of `JOB_LEASE_SECONDS` (heartbeat); a dead worker's job is
  re-claimed once the lease expires. Graceful shutdown: in-flight jobs get `JOB_SHUTDOWN_GRACE_SECONDS`, the rest is
  aborted and RELEASED (attempt not charged). Keep the grace below `SHUTDOWN_TIMEOUT_MS`.
- **Polling** is adaptive per queue (`JOB_POLL_INTERVAL_MS` -> 2x -> 5x -> `JOB_POLL_MAX_INTERVAL_MS` while empty; back to
  fast at once when a job is claimed or enqueued in the same process; a job enqueued by ANOTHER process (the API) waits at most the
  max interval). Per-queue concurrency: `JOB_CONCURRENCY=imports.process:1,invites.send:4,default:2`.
- **Scheduled handlers** (`everyMs`): the scheduler only ENQUEUES a system job keyed `<name>:<time slot>` (unique), so any
  number of worker instances run each purge once per slot, with retries.

## Academic structure, profiles and bulk import (step 5)

- **Academics** (`/academic-years /terms /departments /programs /batches /sections`): all rules are in the database
  (migration 0011): one current year per tenant (deferrable exclusion), no overlapping terms in a year (`btree_gist`
  exclusion; the extension IS available on Cloud SQL, no trigger fallback is in use), terms inside their
  year, unique codes, immutable parents, archive refused while ACTIVE children exist (409, no cascade), a child cannot be
  created / unarchived under an archived parent, everything `ON DELETE RESTRICT` (hard delete only when unreferenced:
  409 `in_use`). The six entities share one generic repository / controller / routes driven by `academics.entities.ts`;
  every change is one fused statement (4 round trips).
- **Profiles** (`member_profiles`, one per membership): student = register number + batch + section (department derived
  from the batch by trigger; the profile read also returns `programId` / `programName` / `programCode`, derived through the batch; the section must belong to the batch by composite FK); faculty / staff = employee id +
  department. Section moves are within the batch, single or bulk (one statement, one audit entry per student).
  `GET /members` filters by `profileType`, `departmentId`, `batchId`, `sectionId`.
- **Bulk import** (`/imports`): upload (streamed multipart, `csv-parse`, never buffered whole) -> staging table
  `import_rows` -> ONE set-based validation UPDATE (the dry run writes nothing to real tables) -> review
  (`/imports/:id/rows`, `/errors.csv`) -> confirm (`skipInvalid` required when rows are invalid; `updateExisting` optional)
  -> the `imports.process` job applies batches of `IMPORT_BATCH_SIZE` rows per transaction with set-based SQL
  (`import_ensure_users` definer function for NEW accounts, then memberships, profiles, invite jobs, row results in one
  statement; ~4 round trips per 500 rows). Row status flips in the same statement as the writes, so a crash or retry
  never applies a row twice; counts are recomputed from the rows. One queued/processing import per tenant (partial
  unique index -> 409 `import_in_progress`); an import whose job is dead-lettered is failed by `imports.reap`.
  Imports never rename an existing user, new memberships are `pending` + an invite (sent by the `invites.send` queue at
  `INVITE_RATE_PER_SECOND`, never inside the import transaction), suspended members are never touched. Staged rows
  (names, emails) are purged `IMPORT_RETENTION_DAYS` (7) after the import ended; the summary and audit entries stay.
- **Formula injection (column-aware)**: input rejects a cell starting with `=` or `@`, a tab or CR in EVERY column; a
  leading `+` / `-` only in numeric-kind columns (phone) when the rest is digits, spaces and hyphens (`+91 98765 43210`
  ok, `+SUM(A1)` rejected in a name). OUTPUT (error report) always prefixes `'` to any cell that starts with `= + - @ tab CR`.
  The rule and its tests live in `imports.csv.ts`.

## Courses, content and files (step 6)

Full reasoning: `docs/adr/0013-courses-content-storage.md`. Numbers: `docs/benchmarks.md`.
- **Domain**: `courses` (department OPTIONAL) -> `course_offerings` (draft | published | archived) -> `offering_sections` +
  `course_participants` (instructor | assistant | learner; `source` manual | section). Admin-managed participants for now:
  instructors and assistants only READ the class list (`participant.read`).
- **`scope: 'offering'` routes** (`config: { permission, scope: 'offering' }`): the hook only needs a session; the service
  puts the access CTE (`courses/courses.access.ts`, exported from the courses index) into the SAME statement as the work:
  non-participant -> 404 `offering_not_found`, participant lacking the permission -> 403. Administrators (`course.read`)
  see every offering; `course.edit/publish` still need participation. A new such route needs the CTE, a matrix row and a
  body in `test/offering-scope.test.ts` (that test fails otherwise).
- **Enrolment sync**: triggers (migration 0016) record changed members in `course_sync_pending` and queue ONE `courses.sync`
  job while none is QUEUED (a running one does not suppress the next); the job applies 200 members per transaction and
  deletes them in the same transaction. Manual participants and administrator removals are never touched by it. The apply
  statement probes every table per member by unique key and the batch transaction sets `enable_seqscan = off` (a freshly
  loaded college has no statistics: measured 61 s -> ~10 s for 10,000 students x 200 offerings, docs/benchmarks.md).
- **Content**: fractional `position` keys (`lms.position_between`, move = one row), rich text = validated JSON only
  (`content.richtext.ts`, never HTML), learner outline = ONE statement, locked entries are sent as title + `availableFrom`
  only, video items are refused until Step 7. Copy = one set-based statement (inline up to 500 items, else the
  `content.copy` job); copied items SHARE file rows.
- **Files**: `POST /offerings/:id/files` (signed upload URL) -> browser PUTs -> `POST /files/:id/confirm` (reads the bytes,
  checks size, extension + magic bytes, records SHA-256; **7 round trips, the one documented exception**). Downloads go
  through `GET .../items/:itemId/download` (signed URL; inline only PDF/PNG/JPEG). `STORAGE_DRIVER=local` is refused in
  production; its `/api/storage/*` routes are rate limited and keep CSRF + a Content-Length precheck (413). The
  `files.purge` job deletes a file only when unreferenced AND older than `FILE_PURGE_GRACE_HOURS` (24) counted from the later
  of confirmation and the last removed reference.
- **Frontend**: the builder is its own lazy route with dnd-kit AND button equivalents for every move; the Tiptap editor is a
  separate chunk, prefetched in idle time after the builder loaded, and `pnpm bundle:check` fails if anything but the builder
  can reach it. Dependencies are pinned exactly; Tiptap is 3.31.4 because 3.32.1 was inside the minimum release age.

## Video lessons (step 7)

Full reasoning, versions and numbers: `docs/adr/0015-video.md`, `docs/video-cost-model.md`, `docs/benchmarks.md`.
- **Provider interface** (`core/video`): `VIDEO_PROVIDER=local|gcp|bunny`. `local` (ffmpeg in the worker, HLS served by this
  API with signed tokens) is for **development and CI only** and is **refused when `NODE_ENV=production`** (`assertVideoPolicy`):
  ffmpeg is never shipped in a production image, production uses a managed provider that carries the codec licensing. `gcp` and
  `bunny` are 503 stubs with TODOs. ffmpeg / ffprobe must be on the PATH (pinned build, `.github/scripts/install-ffmpeg.sh`;
  the video tests fail loudly without them).
- **Upload**: resumable and chunked through the API (`POST /offerings/:id/videos`, `PATCH .../upload` with `Upload-Offset`,
  `GET .../upload` = the resume point, `POST .../complete`). The STORED BYTES are the truth about where the upload stands. Every
  route is `scope: 'offering'`, `course.edit`, 4 round trips; the queue job is enqueued in the same statement as the state change.
- **Transcoding** (`video` queue, `JOB_CONCURRENCY=video:1` default): one ffmpeg run, H.264 (CRF 23, veryfast, maxrate-capped) + AAC,
  **fMP4** segments of 6 s (`init.mp4` per rendition), ladder 360/480/720 named for the short side, never upscaled, aligned key
  frames. Untrusted input: `-protocol_whitelist file`, no shell, hard timeout, output only in the job's directory, probe limits.
  Failures carry a readable reason and are not retried; shutdown kills ffmpeg (and waits for it to exit before removing files).
- **Playback**: `POST /offerings/:id/items/:itemId/playback` (`content.view`, same visibility as the outline) -> a session whose
  token is in the URL PATH (`/api/video/play/<token>/<assetId>/master.m3u8`, relative playlist URIs). The local provider also
  requires the session cookie of the SAME user; the validated session is cached per (session, token) for
  `VIDEO_SESSION_CACHE_TTL_SECONDS` (60, bounded): **a revoked session keeps playing for at most that long**; 20 segment requests
  cost 1 statement. Responses carry `Referrer-Policy: no-referrer`; tokens are redacted from logs (tested). The SPA's CSP needs
  `media-src 'self' blob:`. In production the CDN validates signed URLs / cookies and this API is NOT on the segment path.
- **Copy shares the asset** (like files); unreferenced / abandoned videos are purged after `VIDEO_UPLOAD_GRACE_HOURS`, the
  original is deleted `VIDEO_SOURCE_RETENTION_DAYS` after a successful transcode; scratch directories of crashed workers are swept.
- **Frontend**: hls.js 1.7.3 (`hls.js/light`) in its own lazy chunk reachable only from the video item page and the builder
  preview (`pnpm bundle:check` fails otherwise); the page opens with the poster and a Play button and loads the player on
  hover / focus / Play. The player emits `playerEvents` (play, pause, seek, ended, heartbeat) for step 8; nothing is stored yet.
  Captions: up to 5 WebVTT languages per video. The watermark (viewer's name and address) is a deterrent only.

## Tenant-isolation rules (most important rules in the repo)

1. Tenant data is touched ONLY through `db.withTenant(tenantId, async (tx) => …)` (opened by services). It opens a
   transaction and sets `app.tenant_id` (and `app.user_id` when given; transaction-local, i.e. `SET LOCAL`).
   Two other entry points exist and cannot read tenant data: `db.withUser(userId, …)` (signed-in user, no tenant:
   platform-admin sessions) and `db.withoutTenant(…)` (plain autocommit connection for calling the SECURITY
   DEFINER auth functions before a tenant is known). RLS makes every tenant table empty in those two.
2. With no tenant set, every tenant table returns zero rows (policies compare against `lms.current_tenant_id()`).
3. The app connects as role **`lms_app`**: `NOBYPASSRLS`, owns nothing, least-privilege grants. The
   `postgres` owner role is for migrations/seed/tests only. Never use the owner URL in app/worker code.
4. RLS enabled **and forced** on every table in schema `lms`; policies are `TO lms_app` with a tenant condition.
   Never write a policy that is `USING (true)` for `lms_app` or PUBLIC (test `policies.test.ts` enforces it).
5. Owner policies (`owner_all`, `TO <owner role>`) exist only when the owner role lacks BYPASSRLS (Cloud SQL).
6. Composite foreign keys include `tenant_id` so cross-tenant references are impossible at the DB level.
   Indexes lead with `tenant_id`.
7. `users` is global but protected by RLS: a user is visible only if they have a membership in the current
   tenant or `id = app.user_id` (optional `withTenant(..., { userId })`). `tenant_memberships` is visible only
   for the current tenant. `audit_log` is append-only for `lms_app` (INSERT + SELECT only).
8. Lookups that happen _before_ a tenant is known (login by email, tenant by subdomain, session by token hash, token
   redemption) use narrow `SECURITY DEFINER` functions (migration 0005), never wider RLS. Hardening rules for every
   such function: owned by the migration role, `SET search_path = lms, pg_temp`, schema-qualified objects, `EXECUTE`
   revoked from PUBLIC and granted to `lms_app` only, narrow documented return columns. A new one needs tests like
   `backend/test/auth.functions.test.ts` (grants, search_path hijack, columns).
9. Explicit transactions wherever tenant data is touched. No tenant-owned table without RLS + tenant_id.

## Authentication (step 2)

Own sessions in Postgres; no third-party auth provider. Modules: `auth` (flows), `sessions` (session store).
- **Tenant from the Host**: `<slug>.<APP_BASE_DOMAIN>` = tenant, `admin.<APP_BASE_DOMAIN>` = platform admin area, anything
  else = no tenant (health probes, docs). Unknown or suspended tenant -> 404. Locally use `*.localhost`. Reserved slugs
  (`admin`, `www`, `api`, …) are blocked by a CHECK. Links in emails are built only from the validated slug + base
  domain, never from raw Host text.
- **Session** = 32 random bytes (base64url) in an httpOnly, SameSite=Lax cookie (`__Host-sid` + Secure in production,
  `sid` locally). Only SHA-256 of the token is stored. Idle (7 d) and absolute (30 d) lifetimes via env. Login always
  issues a fresh token; logout / password change / reset / role change revoke sessions. A session is bound to its
  tenant: it is ignored on any other host. Per-request cost: one indexed query (`auth_lookup_session`) which also
  checks membership is `active`, tenant is `active`, expiry and revocation, and refreshes `last_seen_at` at most every 5 min.
- **Credentials** live in `user_credentials` (argon2id via `@node-rs/argon2`, PHC string, rehash on login when parameters
  change). `lms_app` has NO privilege on it; only SECURITY DEFINER functions touch it. Passwords: 10-128 characters,
  common-password list, NFKC-normalised; no composition rules.
- **Login** is generic on every failure (same error, an argon2 verify always runs, failure bookkeeping is deferred to a
  background task so timing does not leak existence). Lockout: after `LOGIN_MAX_ATTEMPTS` wrong passwords the account is
  locked for 60 s doubling, **capped at 15 min**; attempts while locked are not counted; reset/unlock clears it at once.
  Institution admins unlock members of their tenant (`POST /auth/members/:userId/unlock`), platform admins on the admin host.
- **CSRF**: every POST/PUT/PATCH/DELETE needs an Origin (or Referer) equal to the request host AND `X-Requested-With: lms`.
  Nothing is exempt. The SPA and dev proxy must send both.
- **Rate limits** (in-memory): stricter per-IP and per-email limits on login, password-reset request and invite accept.
- **Request context**: `registerAuthContext` (core) sets `request.auth` / `request.tenant`; controllers build a plain
  `RequestContext` for services (`contextFrom(request)`); services never see the request. `core/auth-guards.ts` only
  has `requireKnownHost` now: authorization is declared per route (see "Authorization (step 4)").
- **Audit**: login success/failure, lockout, unlock, logout, password change/reset, invite created/accepted go to
  `audit_log` (tenant host) or `platform_audit_log` (admin host, via a definer function). Platform-admin
  access inside a tenant must use `auditService.withPlatformAdminAccess` (audit entry in the same transaction); no
  endpoint uses it yet: platform admins cannot log into tenant hosts in step 2. Never log passwords, tokens or hashes
  (logger redaction + a test that fails if one appears).
- **Email** goes through the `Mailer` interface in core (`MAILER=console` for dev; it logs links, so it is rejected in
  production; tests use the capturing fake). Invite tokens last 7 days, reset tokens 30 minutes, both single-use and
  stored only as SHA-256.
- **Bootstrap**: `pnpm admin:create --email you@example.com` creates the first platform admin (password from a hidden
  prompt or `ADMIN_PASSWORD`, never from arguments). `pnpm db:seed` gives seeded users `SEED_USER_PASSWORD` and refuses
  to run in production.
- **Cleanup jobs (worker)**: `sessions.purge_dead` and `auth.purge_tokens` (handlers in `sessions.handlers.ts` /
  `auth.handlers.ts`) delete sessions that died, and tokens that were used or expired, more than `PURGE_RETENTION_DAYS`
  (default 30) ago, at most `PURGE_BATCH_SIZE` (default 1000, clamped to 10000 in SQL) rows per statement, looping until a
  short batch (and never more than 100 batches per run). `lms_app` has no DELETE on those tables: the work is done by the
  definer functions `auth_purge_sessions` / `auth_purge_tokens`. The worker runs them every `PURGE_INTERVAL_SECONDS`
  (default 3600) with the fixed-interval scheduler in `core/scheduler.ts` (no overlap, errors reported, stop() waits);
  Cloud Scheduler will trigger the same handlers on GCP. Handlers declare `everyMs` in their `HandlerMap` entry.
- **Dev database hygiene**: `pnpm db:dev:clean --yes --project-ref local` removes benchmark tenants and the
  sessions / auth audit noise from the DEV database (owner connection). It refuses in production, on Cloud Run, for any
  host that is not localhost (or a legacy hosted pooler), for the test databases, and unless the typed confirmation
  (`local`, or the project ref of a remote URL) matches `DATABASE_URL`. `pnpm bench` creates and deletes its own throwaway `bench-*` tenant, so it leaves nothing behind.
- **Threadpool**: argon2 runs on the libuv threadpool, shared with DNS lookups. Hash concurrency is capped
  (`PASSWORD_HASH_CONCURRENCY=2`, bounded queue -> 503 `busy`) and the start scripts set `UV_THREADPOOL_SIZE=8` via
  `cross-env` (it must be set before the process starts). **The future Cloud Run Dockerfile must set
  `ENV UV_THREADPOOL_SIZE=8`** (or run the start script).

## Secrets

- Never commit credentials. `.env` / `.env.*` are git-ignored; `.env.example` holds placeholders only.
- **Scanning**: gitleaks with `.gitleaks.toml` (default rules + database URLs with a password). Pre-commit hook in
  `.githooks/` (enabled by `pnpm install` via `core.hooksPath`; needs the gitleaks binary), CI job `secrets` scans the full
  history, `pnpm secrets:scan` does it locally. Allowlist entries need a comment saying why the value is dead or fake.

## Database migration discipline

- **Forward-only.** Never edit an applied migration (the checksum check fails); fix with a new migration.
- **Expand -> migrate -> contract** for breaking changes: add the new column/table (nullable or defaulted), backfill, switch
  the code, and only in a LATER migration drop the old one. Never rename or drop in the same release that stops using it.
- Every migration must run cleanly on an **empty DB** (CI) and on the **existing dev DB**.
- Every new table: `tenant_id` + RLS enabled and forced (if tenant-owned), `lms_app` grants limited to what is needed
  (no grant at all for tables only reachable via definer functions), indexes leading with `tenant_id`, the module's
  `<module>.model.ts` updated, and the schema-drift / policy-audit / isolation test lists updated.

## Database rules

- **Migrations only.** Never edit tables / policies / roles by hand in pgAdmin or psql (except throwaway experiments in
  a scratch schema that you drop).
- Every schema change = a new numbered file in `backend/migrations/` (never edit an applied one; the
  runner stores `filename + checksum` in `lms.schema_migrations` and fails on a changed checksum).
  Runner: advisory lock (no concurrent runs), one transaction per file.
- After a migration, update the module's `<module>.model.ts`; `schema-drift.test.ts` compares tables, columns,
  types and nullability against the live DB.
- `lms_app` password: migration creates the role without one; `pnpm db:migrate` runs `ALTER ROLE` from
  `LMS_APP_PASSWORD` only when it changed (fingerprint in `lms.role_password_state`; the role is CLUSTER-wide, so one
  password serves every database on the server). It must equal the password in `DATABASE_APP_URL`. Never log or commit it.
- Pool size: `DB_POOL_MAX`, default **5 in development/test, 10 in production**. Local PostgreSQL allows 100 connections
  and every test worker holds a few; Cloud Run scales horizontally, so size = (per-instance) × (max instances) < Cloud SQL max.
- TLS: `DB_SSL=off|no-verify|verify-full` (+ `DB_SSL_CA` path). **`off` only for a database on localhost / 127.0.0.1 and
  never when NODE_ENV=production** (every database URL the process reads is checked; messages never echo the host).
  `no-verify` only in development/test (warns at startup). Production needs `verify-full` + `DB_SSL_CA`.

## Testing rules

- **Always write and run tests yourself. Never hand manual testing (Postman/browser) to the user.**
- Vitest has three projects (`backend/vitest.config.ts`): `unit` (`*.unit.test.ts`, fakes, no DB), `db` (everything
  else, a real PostgreSQL, run **in parallel**: N = CPU cores - 1 workers, `TEST_DB_WORKERS` overrides, one database per
  worker `<TEST base name>_<VITEST_POOL_ID>`, created + migrated once per run by `test/global-setup.ts` and reused) and
  `serial` (files that must run alone, listed with their reason in `SERIAL_FILES`: migration runner / ALTER ROLE,
  SIGTERM process test, wall-clock jobs and worker tests, the 10,000-row import). `pnpm test` runs unit+db in parallel,
  then serial with one worker. Profiles: local (10 s per test) and `REMOTE_DB=1` / `pnpm --filter @lms/backend test:remote`
  (a slow remote database: 120 s per test, ONE worker on the single given database, no CREATE DATABASE).
- Tests in the parallel project must not assume wall-clock gaps between statements (a fast local database finishes
  neighbouring tests within the same second): scope time-window assertions to the data the test created.
- API tests use Fastify `inject()` against the REAL test database. No DB mocks outside `*.unit.test.ts`.
- `resetLms()` (backend/test/support.ts) TRUNCATEs schema `lms` (except `schema_migrations` and `role_password_state`)
  via the owner connection before each DB test file, in the worker's own database. Guard (`test/guards.ts`, re-checked by
  every test entry point): tests refuse to run unless `TEST_DATABASE_URL`/`TEST_DATABASE_APP_URL` exist, name the same
  database, a safe lowercase name that is not a system database, and **never a database NAME equal to the dev database
  (base name or derived worker name), on any host**; the same project / project ref as the dev URLs is refused too;
  production is refused. Never run destructive resets against the dev database.
- **Verification policy.** While working on a step: run the AFFECTED tests only. At the END of a step: ONE full local
  run (`pnpm test`) plus CI. The "three full runs" flakiness check lives in CI (nightly job `flakiness` runs the suite 3 times)
  and in tests that have ever failed intermittently (run those repeatedly when you touch the code they cover).
- The app's readiness timeout stays short (2s default).
- `backend/test/query-budget.test.ts` enforces the round-trip budgets (see above).
- **Frontend tests** (`frontend/test`): Vitest + Testing Library + MSW with handlers typed from the contracts (`test/server.ts`);
  a typed fixture changes when a contract changes, so drift breaks the build. **E2E** (`pnpm e2e`): Playwright against the real
  API, worker and PostgreSQL in the dedicated database `lms_e2e` (guard: `backend/test/e2e-database.ts`, same refusals as the
  test databases; migrated, truncated and seeded before every run), `MAILER=file` for emailed links, axe (fails on serious or
  critical violations) on every main screen in light, dark and at 360 px. It is serial and takes about 1-2 minutes locally.
- Required coverage that must stay green: health, error shape/no leaks, tenant isolation, role model, env validation,
  SSL policy, migration runner, schema drift, policy audit, layering (`pnpm lint`).
- Graceful-shutdown signal test runs on Linux/macOS only (Windows cannot deliver SIGTERM to Node).

## Round-trip budget (every statement sent to Postgres is a network round trip)

Cloud SQL in the same region answers in ~1 ms; from a laptop to the remote dev DB each statement costs ~200 ms, and
every extra statement also holds a pooled connection longer. So round trips are budgeted like memory:
- **Every new endpoint gets a query-budget test** in `backend/test/query-budget.test.ts` (it counts every statement,
  including BEGIN / `set_config` / COMMIT and the deferred background work the request triggers, via the `onStatement`
  hook in `db/connection.ts`). **Adding a round trip to an existing hot path needs a reason in the PR and a budget change.**
- Current budgets (steady state: slug cache warm, pool warm): `/health/ready` 1; any authenticated request pays **1**
  for the session lookup (`/auth/me` total 1, budget 2); `POST /auth/login` 2 (budget 4); `POST /auth/logout` 2
  (budget 3); an authenticated tenant read = 1 lookup + one `withTenant` transaction (3) = 4.
  Step 4: `GET /members`, `GET /members/:id`, `GET /audit` 4 (the page is ONE query, user joined); every member mutation
  (role, suspend, reactivate, delete, resend-invite) 4 = lookup + BEGIN + one fused statement + COMMIT; platform reads /
  rename / suspend / reactivate 2 (lookup + one definer call); `POST /platform/tenants` and `admin-invite` 3;
  `GET /platform/tenants/:id/members` 6 (two audit writes + the read).
  Step 5b: public `GET /tenant/info` 3 (no session; one `withTenant` read), `PATCH /tenant/branding` 4 (one fused statement incl. audit).
  Step 6: every courses / offerings / participants / content endpoint 4 (the learner outline of 20 x 15 included: ONE statement);
  `POST /files/:id/confirm` 7 (two short transactions around the storage read: documented exception); the local storage PUT 1.
  Step 7: every video endpoint 4 (create, read, offset, chunk, complete, delete, captions, the playback session; the outline with
  a video item is still ONE statement); a playback FILE request costs 0 after the first of its session (cache), the first costs 1.
  Step 5: academics reads 4, every academic change 4 (one fused statement), profile read / upsert / section moves 4,
  `GET /members` with profile filters 4, `GET /imports*` 4 (`/rows` and `/errors.csv` 5: the import and its page share a
  transaction), confirm / cancel 4, `POST /imports` = 7 + 1 per 1,000 rows staged (10,000 rows: 16 statements). The worker
  costs ~4 round trips per 500-row batch.
- How the budget is met: `withTenant` / `withUser` send `BEGIN; SELECT set_config(...)` as ONE simple-query message (then
  the work, then COMMIT = 2 round trips of overhead; context values are inlined only after the UUID check, never user
  text). Anything that is a single statement runs through `db.withoutTenant` (autocommit, no transaction at all). Flows
  that used to be 4-8 sequential statements are one SECURITY DEFINER call (`auth_login_begin`, `auth_login_complete`,
  `auth_login_failed`, `auth_logout`, `auth_reset_password`, `auth_change_password`); fold work into one statement when the
  logic stays clear, never at the price of authorisation checks.
- No request may run sequential queries that could be one statement (joins/CTEs instead of query-per-row; no N+1).

## Performance rules

- Response schemas on every route. No unbounded queries — always paginate (keyset, `core/pagination.ts`).
- No N+1. Select only needed columns. Every hot-path query backed by an index.
- Never block the event loop (no sync fs/crypto in request paths). Stream large payloads.
- **Set-based SQL must not depend on the planner's estimates.** A new tenant (or a table just bulk-loaded) has no
  statistics, so the planner believes every table has ~1 row and picks nested loops that are quadratic (measured: a dry
  run of 3 rows in a college with 10,000 members took 287 s; the 10,000-row import 25-60 s instead of 8 s). Write the
  statement so every plan is linear: join updates by `ctid` / primary-key arrays for exactly the batch's rows, look rows up
  by a unique key per row (scalar subquery / `LATERAL ... OFFSET 0`), compare two sets with window functions over their
  UNION (sort based, no join to misjudge). Row-level security keeps `= ANY(array)` out of index conditions. Check with
  `IMPORT_PROFILE=1 pnpm --filter @lms/backend exec vitest run --project serial test/imports.scale.test.ts -t 10,000-row`
  (per-statement timings of the worker connection and `EXPLAIN (ANALYZE, BUFFERS)` of the batch statements; run it ALONE).
- No micro-optimizations that hurt readability without a benchmark proving the gain. Measure, then optimize.

## Conventions

- Biome for lint+format (`pnpm lint`, `pnpm lint:fix`); `noFloatingPromises` is an **error**. Single quotes, 2 spaces, 100 cols.
- TypeScript strict + `noUncheckedIndexedAccess`. **TypeScript is pinned to 6.0.x** because dependency-cruiser does
  not support TS 7 yet; bump when it does.
- Backend code is bundled with tsup (`dist/server.js`, `dist/worker.js`); frontend with Vite.
- Errors: throw `AppError` subclasses (`core/errors.ts`, `<module>.errors.ts`) for expected failures; everything
  else becomes `internal_error` (details only in logs). Error body: `{ error: { code, message, requestId, details? } }`.
- Logs are pino JSON with `request_id`; call `bindTenantToLog(request, tenantId)` once the tenant is known.
  Sensitive keys are redacted; query strings and bodies are never logged.
- New routes: TypeBox request + response schemas (including `ErrorResponseSchema` for error statuses), tags for OpenAPI.
  Health probes opt out of rate limiting with `config: { rateLimit: false }`.
- Env: validated at startup (`parseApiEnv`, `parseWorkerEnv`, `parseMigrateEnv`); messages never echo values.

## Commands

```
pnpm install
pnpm dev                 backend API :3000 + frontend :5173 (proxies /health) in parallel
pnpm dev:worker          background worker (tsx watch)
pnpm build               backend (tsup) then frontend (tsc + vite)
pnpm lint                Biome + dependency-cruiser (layering rules)   | lint:fix | lint:deps | format
pnpm typecheck           pnpm test        (backend: unit + db in parallel, then the serial files; then frontend; needs .env TEST_ vars)
pnpm db:local:setup     once: roles anon/authenticated + the dev database on local PostgreSQL (refuses non-localhost)
pnpm db:migrate          pnpm db:seed     (dev DB, owner connection)
pnpm admin:create --email x@y.z   first platform admin (hidden password prompt or ADMIN_PASSWORD)
pnpm db:dev:clean --yes --project-ref <ref>   dev DB only: remove bench tenants + auth noise (guarded)
pnpm start               built API (sets UV_THREADPOOL_SIZE=8)    | pnpm dev:worker
pnpm bench               autocannon on /health/live and /health/ready (docs/benchmarks.md)
pnpm docs:permissions    regenerate docs/permissions.md (--check = fail if stale; CI runs it)
pnpm --filter @lms/backend run bench:members   GET /members incl. the section filter (throwaway tenant, self-cleaning)
pnpm --filter @lms/backend run bench:courses   learner outline, my courses, one student moving section at 10,000 students / 200 offerings
pnpm --filter @lms/backend run bench:search    EXPLAIN experiment for member search, throwaway schema, self-cleaning
pnpm --filter @lms/backend run bench:video    transcode speed + GB per viewing hour per rendition + playback-session latency (needs ffmpeg)
pnpm e2e                 Playwright E2E (lms_e2e)   | pnpm bundle:check (after build) | pnpm lighthouse | pnpm screenshots
```
Per package: `pnpm --filter @lms/backend run <script>` / `pnpm --filter @lms/frontend run <script>`.
Env: copy `.env.example` → `.env` (git-ignored). Backups `.env.*` are git-ignored too. CI creates `anon` and
`authenticated` roles before migrating, exactly like `pnpm db:local:setup`.

## TODO / known gaps

- **Video (step 7)**: only the local provider works; the GCP Transcoder + Cloud CDN provider and the managed-service provider are
  stubs (503). No DRM (a web page cannot prevent screen recording; the watermark is a deterrent). Progress tracking (step 8) will
  consume the player events; nothing is stored. Renditions are fixed for lectures (360/480/720). A re-transcode after the original
  expired needs a re-upload. The session cache is per API instance (revocation can take up to its TTL).

- **Rate limiter is in-memory (per instance): needs a shared store (e.g. Redis/Memorystore) before production.**
- Production TLS: `DB_SSL=verify-full` + `DB_SSL_CA` (Cloud SQL server CA); `off` is refused in production.
- Jobs enqueued by the API are picked up by the worker within `JOB_POLL_MAX_INTERVAL_MS` (no LISTEN/NOTIFY yet).
- The invite email of an import uses the college's origin built from `APP_BASE_DOMAIN` (+ `APP_PUBLIC_PORT` in development).
- A phone number is the only numeric-kind import column today; add new numeric columns in `imports.csv.ts` with `kind: 'numeric'`.
- **Malware / virus scanning of uploaded files before they become `ready` is NOT built** (GCS pipeline step: scan, then
  verdict checked in `POST /files/:id/confirm`). Not needed for the local development driver.
- The GCS storage driver is a stub (503); signed URLs, object metadata instead of re-reading bytes, lifecycle rule for abandoned
  uploads are GCP-step work. Object deletion after the purge removed the row is best effort (a crash in between leaves an orphan
  object; list-and-compare job later).
- Course participants are managed by administrators only; per-membership capability flags (e.g. instructors managing their
  own class list or creating courses) are planned, not built.
- Per-membership capability flag (e.g. `can_create_courses`) if faculty must create courses: planned, not built.
- The tenant slug cache (`TENANT_CACHE_TTL_MS`) is per instance: a newly created or suspended college is seen by other
  instances within the TTL (suspension is enforced immediately for sessions regardless).
- A platform admin cannot sign in on a tenant host; the only cross-tenant access is the audited member view.
- Production gateway: `/api/*` -> API service, everything else -> SPA, no rewrite (README "Production routing"); logos for the
  college branding come with file storage.
- Real mail provider (only `console`, `file` (dev/E2E) and capturing mailers exist); the auth rate limits are per instance.
- Re-run the full suite on Node 24 (local machine was on 22).
- Upgrade TypeScript to 7.x once dependency-cruiser supports it.

# ADR 0007: Module-based layered backend + frontend/backend split

Status: accepted (supersedes the apps/ + packages/ layout from step 1)

## Context

Step 1 split the code by technical concern into `apps/api`, `apps/worker`, `apps/web` and `packages/{db,shared,config}`.
That layout spreads one domain concept (say, memberships) across several packages, hides the real
architecture (a modular monolith with one API and one worker sharing the same domain code), and makes
"who may call whom" a convention rather than a rule. Turborepo added build orchestration we do not need
for two packages.

## Decision

- **Two workspace packages**: `backend/` (API + worker + DB code) and `frontend/`. No Turborepo; root scripts call
  `pnpm --filter`.
- **Backend is organised by module**, each with a fixed set of files and layers:
  `routes → controller → service → repository`, plus `schemas`, `model`, `errors`, `handlers` and a public
  `index.ts`. Cross-cutting code lives in `config/`, `db/`, `core/`; shared API types in `contracts/`.
  Wiring is plain factory functions with explicit dependencies in one composition root; no DI framework,
  decorators or classes (except errors).
- **Services own transaction boundaries** and are the only layer that calls `db.withTenant`; repositories are SQL
  only and receive the transaction. This keeps tenant isolation (ADR 0002) a service-level decision that is easy
  to audit, and keeps repositories trivially testable and reusable inside a larger transaction.
- **`<module>.handlers.ts` = background-job and domain-event handlers, not a second HTTP layer.** The worker is the
  same codebase with a different entrypoint. Work that must not run inside a request (emails, imports, fan-out
  after an event) is triggered by a job or event; its handler is the worker-side counterpart of a controller:
  it takes a payload, calls the module's _service_, and returns. Business rules therefore live once, in the
  service, and are reachable from HTTP (via controllers) and from background work (via handlers) alike.
  A "second HTTP layer" (e.g. internal REST controllers for the worker) would duplicate validation, add
  network hops and blur the layering rules.
- **Layering is enforced automatically** with dependency-cruiser in `pnpm lint` and CI (routes → controller/schemas/core
  only; controller never touches repository/model/db; repository never reaches up; modules talk only via
  `index.ts`; backend never imports frontend; frontend imports backend only via `@lms/backend/contracts`; no cycles).
- **Shared contracts**: TypeBox schemas and types the frontend needs live in `backend/src/contracts/` and are exposed
  through the `./contracts` subpath export. The frontend uses `import type` so no server code reaches the browser.

## Consequences

- A reader can open one module folder and see a whole vertical slice; adding a module is a checklist (CLAUDE.md).
- Rules are executable: an accidental `controller → repository` import fails CI.
- Two packages instead of seven: simpler installs and scripts; there is no longer a `packages/db`-style boundary,
  so boundaries inside `backend/` are protected by the dependency rules instead of package borders.
- TypeScript is pinned to 6.0.x until dependency-cruiser supports TypeScript 7.
- Modules currently without HTTP endpoints (tenants, users, memberships, audit) have stub routes/controllers; they
  already provide tested services and repositories for step 2.

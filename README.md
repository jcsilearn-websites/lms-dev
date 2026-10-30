# JCS iLearn LMS

Multi-tenant SaaS Learning Management System. Modular monolith: Fastify API, background worker,
React SPA, PostgreSQL with Row-Level Security. Read [CLAUDE.md](CLAUDE.md) for architecture and rules.

```
backend/    API + worker + DB code (src/modules/<module>/ with routes/controller/service/repository)
frontend/   React + Vite app (app/, features/, shared/)
docs/       ADRs, benchmarks, Cloud SQL migration guide
```

## Prerequisites

- Node.js 24 LTS (`.nvmrc`), pnpm 11 (`corepack enable` or `npm i -g pnpm`)
- PostgreSQL 17 installed locally (no Docker needed): [ADR 0011](docs/adr/0011-local-postgres-for-dev-and-tests.md)

## Local PostgreSQL setup (Windows)

1. Install PostgreSQL 17 with the EnterpriseDB Windows installer (pgAdmin is included). Keep port **5432** and remember
   the password you give the `postgres` superuser.
2. Copy the env file and fill it in (`.env` and `.env.*` are git-ignored):

   ```
   cp .env.example .env
   ```

   Set the owner URLs (`DATABASE_URL`, `TEST_DATABASE_URL`) with the `postgres` password, and generate the app password
   (letters and digits only), used as `LMS_APP_PASSWORD` **and** inside both `lms_app` URLs:

   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

   Dev database is `lms_dev`, test base name is `lms_test`, `DB_SSL=off` (allowed for localhost only).
3. Create the roles `anon` / `authenticated` and the database `lms_dev` (the test databases are created by the test run):

   ```
   pnpm install
   pnpm db:local:setup
   ```

   The command refuses any host except localhost. Tests refuse to run when the test database name equals the dev name.

## Run

```
pnpm install
pnpm db:migrate     # applies SQL migrations, sets the lms_app password from LMS_APP_PASSWORD
pnpm db:seed        # 1 platform admin, 2 demo tenants (admin + 4 members each), all with SEED_USER_PASSWORD
pnpm dev            # backend API http://localhost:3000 (docs at /docs) + frontend http://localhost:5173
pnpm lint           # Biome + dependency-cruiser (architecture/layering rules)
pnpm typecheck && pnpm build
pnpm test           # backend (unit + real-DB tests) then frontend
pnpm bench
```
`DB_POOL_MAX` defaults to 5 in development/test and 10 in production.

`pnpm test` runs the unit and database tests in parallel (one database per worker: `lms_test_1 ... _N`, N = CPU cores - 1,
`TEST_DB_WORKERS` overrides), then the few files that must run alone. `REMOTE_DB=1` selects the slow-remote-database profile.

## Notes

- Schema changes go through migrations only — never edit tables by hand in pgAdmin or psql.
- CI (GitHub Actions) runs lint, typecheck, build and tests against a `postgres:17` service container.
- Moving to Google Cloud SQL (production TLS: `DB_SSL=verify-full`): [docs/migrating-to-cloud-sql.md](docs/migrating-to-cloud-sql.md).

## Frontend

React + Vite + TanStack Query + TanStack Router, Tailwind (design tokens in `frontend/src/index.css`, light and dark),
screens in `frontend/src/features/<feature>`, shared pieces in `frontend/src/shared`. Why these choices:
[ADR 0012](docs/adr/0012-frontend.md).

```
pnpm dev                      # API :3000 + web :5173 (hot reload)
pnpm --filter @lms/frontend run test        # component tests (Vitest + Testing Library + MSW)
pnpm e2e                      # Playwright end-to-end tests against the real stack and PostgreSQL (below)
pnpm bundle:check             # bundle budgets (after `pnpm build`): login <= 125 KB gzip, any route <= 150 KB
pnpm lighthouse               # Lighthouse, mobile preset: login page + members list (median of 3)
pnpm screenshots              # docs/screenshots (light/dark x desktop/phone)
```

### Hosts and the `/api` proxy (dev, preview and E2E)

A college is a host name: `<slug>.localhost:5173` (the platform area is `admin.localhost:5173`). Browsers resolve
`*.localhost` to your machine, so cookies are host-only per college exactly like production subdomains. The browser
calls **`/api/...` on its own origin**; the Vite dev server (`frontend/vite.config.ts`) forwards `/api/*` to the API on
`127.0.0.1:3000` **unchanged**: every API route is registered under `/api` (the health probes also stay at the root), because
the SPA owns the other paths (`/members`, `/audit`, ...). Two details matter:

- `changeOrigin: false`: Vite would otherwise rewrite the `Host` header to the target. The API resolves the college from
  `Host` and its CSRF check compares `Origin` with `Host`, so a rewritten Host means 404 or `csrf_rejected`.
- the target is `127.0.0.1`, not `localhost`: Node resolves `localhost` to IPv6 first and the API listens on IPv4.

`VITE_DEV_API_TARGET` points the proxy elsewhere. To open the seeded colleges see "Signing in locally" below.

### UI permissions are cosmetic

`GET /auth/me` returns the caller's `permissions`; the navigation and buttons use them to show only what a person can do.
That is a convenience, **not a security boundary**: the API checks every request again and stays the source of truth
(`docs/permissions.md`). Never rely on a hidden button.

### End-to-end tests

`pnpm e2e` (`frontend/scripts/e2e.mjs`) prepares a dedicated database **`lms_e2e`** on the same local server (created,
migrated, truncated and seeded before every run; the guard refuses anything that could be `lms_dev` or a unit-test database),
builds the SPA, starts the API, the worker and a production-like web server (`frontend/scripts/serve.mjs`: compression,
SPA fallback, `/api` proxy) on ports 3100 / 4173 and runs Playwright serially. Emails go to a git-ignored file
(`MAILER=file` -> `.mail/e2e-outbox.jsonl`) which the tests read for invite and reset links. First time only:
`pnpm --filter @lms/frontend exec playwright install chromium`. On a machine with little free memory close other
heavy applications (a browser with many tabs) before running it.

## Video lessons (development)

Instructors upload videos in the course builder (**Add video**: resumable, chunked); the worker converts them with ffmpeg into
HLS (360p / 480p / 720p) and learners play them in the item page. Needs **ffmpeg and ffprobe on the PATH** (development and CI
only; never in production, see [ADR 0015](docs/adr/0015-video.md)):

- Windows: download the pinned archive named in the ADR from the BtbN releases, check its SHA-256, copy `ffmpeg.exe` and
  `ffprobe.exe` to a folder on your PATH.
- Linux / CI: `bash .github/scripts/install-ffmpeg.sh` (checks the SHA-256 before unpacking).

`ffmpeg -version` should say `n8.1.3-9-g29e619e767`. Measured sizes and speeds: [docs/video-cost-model.md](docs/video-cost-model.md);
`pnpm --filter @lms/backend run bench:video` repeats them on your machine.

## Production routing (GCP TODOs)

The SPA and the API share one origin per college; in production a gateway has to do what `frontend/scripts/serve.mjs` and
the Vite proxy do locally (route `/api/*` to the API, the rest to the SPA):

- **Cloud Load Balancer** (URL map): route `/api/*` to the API service (Cloud Run) and everything else to the SPA (static
  bucket or service) with a fallback to `index.html` for client-side routes. **No URL rewrite** anywhere: the API already
  serves its routes under `/api`. The probes `/health/live` and `/health/ready` are also served at the root for Cloud Run.
- Do **not** rewrite or replace the `Host` header, and forward `Origin`, `Cookie` and `X-Forwarded-*` untouched: the college is
  resolved from `Host`, cookies are host-only, and `TRUST_PROXY` must match the proxy chain.
- Serve `/assets/*` with `Cache-Control: public, max-age=31536000, immutable` (file names are content hashes) and
  `index.html` with `no-cache`; compress text assets (brotli/gzip); send the security headers `serve.mjs` sends (CSP,
  `nosniff`, `frame-ancestors 'none'`). Video needs `media-src 'self' blob:` in that CSP (hls.js plays through a MediaSource),
  and the pages that play video (`/offerings/*/items/*`, `/offerings/*/build`) must send `Referrer-Policy: no-referrer`.
- Wildcard certificate and wildcard DNS for `*.<APP_BASE_DOMAIN>` (tenants) plus `admin.<APP_BASE_DOMAIN>`.
- **File storage (course files)**: production uses `STORAGE_DRIVER=gcs` (a bucket per environment, uniform bucket-level
  access, no public objects; the app hands out V4 signed URLs). The `local` driver is refused when `NODE_ENV=production`.
  The GCS driver is NOT built yet (it answers 503): it must sign PUT URLs with a content-type and size condition and GET
  URLs with `response-content-disposition`, and read size / hash from object metadata instead of re-reading the bytes.
  Let the load balancer / Cloud Run request size limit stay above `STORAGE_MAX_FILE_BYTES` only where the local driver runs.
- **Video lessons**: production uses a managed provider (`VIDEO_PROVIDER=gcp`, GCP Transcoder API + GCS + Cloud CDN signed
  cookies, or a video service such as Bunny Stream / Cloudflare Stream / Mux). `VIDEO_PROVIDER=local` (ffmpeg in the worker) is
  refused when `NODE_ENV=production`, and ffmpeg must never be added to a production image (codec licensing: see ADR 0015). Both
  providers are stubs (503) until the GCP step. The CDN, not this API, must validate the playback URLs / cookies, and the
  gateway must send the CSP and `Referrer-Policy` described above.
- **Malware scanning of uploads (not built)**: before a file becomes `ready` it should pass a scan, e.g. a Cloud Storage
  event -> scanner -> verdict step in the GCS pipeline; `POST /files/:id/confirm` is where the verdict is checked.

## Signing in locally

Tenants are served on subdomains, and `*.localhost` resolves to your machine:

| Who                           | URL                                    | Email                                                             |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Alpha College admin / member  | `http://alpha-college.localhost:5173`  | `admin@alpha-college.example` / `member1@alpha-college.example`   |
| Beta Institute admin / member | `http://beta-institute.localhost:5173` | `admin@beta-institute.example` / `member1@beta-institute.example` |
| Platform admin                | `http://admin.localhost:5173`          | `platform.admin@jcsilearn.example`                                |

All seeded users share the password in `SEED_USER_PASSWORD` (`.env`). The API accepts state-changing requests only with an
`Origin` matching the host and the header `X-Requested-With: lms`. To create a real first platform admin:
`pnpm admin:create --email you@example.com` (hidden password prompt, or `ADMIN_PASSWORD` in the environment).
Production start scripts set `UV_THREADPOOL_SIZE=8` (see CLAUDE.md, Authentication).

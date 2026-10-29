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
- PostgreSQL 18 installed locally (no Docker needed): [ADR 0011](docs/adr/0011-local-postgres-for-dev-and-tests.md)

## Local PostgreSQL setup (Windows)

1. Install PostgreSQL 18 with the EnterpriseDB Windows installer (pgAdmin is included). Keep port **5432** and remember
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
- CI (GitHub Actions) runs lint, typecheck, build and tests against a `postgres:18` service container.
- Moving to Google Cloud SQL (production TLS: `DB_SSL=verify-full`): [docs/migrating-to-cloud-sql.md](docs/migrating-to-cloud-sql.md).

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

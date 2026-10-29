# Migrating from local PostgreSQL (dev) to Google Cloud SQL

The code is portable PostgreSQL: no vendor-specific objects are used. Dev and tests run on a local PostgreSQL 18
([ADR 0011](adr/0011-local-postgres-for-dev-and-tests.md)). Target: Cloud SQL for PostgreSQL 18
(newest major Cloud SQL supports), region asia-south1.

## 1. Provision

- Create the Cloud SQL instance and a database (e.g. `lms`). Enable the Cloud SQL connector / Unix socket for Cloud Run.
- The built-in `postgres` user on Cloud SQL is **not a superuser** (it belongs to `cloudsqlsuperuser`) and
  should not be assumed to have `BYPASSRLS`.

## 2. Run migrations (as `postgres`)

```
DATABASE_URL=postgresql://postgres:<pw>@<host>/lms \
DATABASE_APP_URL=postgresql://lms_app:<APP_PW>@<host>/lms \
LMS_APP_PASSWORD=<APP_PW> NODE_ENV=production DB_SSL=verify-full DB_SSL_CA=<server-ca.pem> \
pnpm db:migrate
```
This creates schema `lms`, the `lms_app` role (LOGIN, NOBYPASSRLS, owns nothing), tables, RLS, grants, and sets
the `lms_app` password. The `anon`/`authenticated` revokes are skipped automatically when those roles do not exist.

### How the owner role works on both platforms

FORCE ROW LEVEL SECURITY applies to the table owner unless it is a superuser or has `BYPASSRLS`. Migration
`0002` therefore checks the migrating role:
- A `postgres` with BYPASSRLS, or the superuser of local PostgreSQL / CI: nothing extra is created.
- Cloud SQL `postgres` (neither): it creates `CREATE POLICY owner_all ON lms.<table> FOR ALL TO <that role>
  USING (true) WITH CHECK (true)` on every table, **explicitly `TO` the owner role**. These policies never apply to
  `lms_app` or PUBLIC; `backend/test/policies.test.ts` fails if any unrestricted policy reaches them.
  After migrating on Cloud SQL, run the test suite against a scratch Cloud SQL database (or check
  `SELECT policyname, roles FROM pg_policies WHERE schemaname='lms'`) to confirm.

## 3. Optional: copy data from another PostgreSQL (e.g. the local dev database)

```
pg_dump --data-only --schema=lms --disable-triggers --no-owner \
  "postgresql://postgres:<pw>@localhost:5432/lms_dev" > lms-data.sql
psql "<cloud-sql-owner-url>" -v ON_ERROR_STOP=1 -f lms-data.sql
```

- Run the migrations on Cloud SQL **first**; restore only data (`--data-only`), so roles/policies come from migrations.
- Do not dump `lms.schema_migrations` into a database that has already been migrated (it would conflict): add
  `--exclude-table=lms.schema_migrations`.
- `--disable-triggers` needs a superuser, which Cloud SQL's `postgres` is not. Instead restore in foreign-key
  order (`tenants`, `users`, `tenant_memberships`, then the rest), or drop `--disable-triggers` and let FK checks run.
- Restore with the owner role (not `lms_app`): on Cloud SQL it passes RLS through the explicit `owner_all` policies.
- Verify counts per table, then run `SELECT 1` readiness against `lms_app`.

## 4. Point the app at Cloud SQL

- API/worker env: `DATABASE_APP_URL` (as `lms_app`), `DB_SSL=verify-full` + `DB_SSL_CA` (the Cloud SQL server CA).
  **`DB_SSL=off` and `no-verify` are rejected when `NODE_ENV=production`**, and `off` is accepted only for
  localhost / 127.0.0.1 in any environment, so a Cloud SQL Unix-socket URL (empty host) would be refused too: use the
  instance's private IP with verify-full, or relax the policy in a reviewed change when the connector is adopted.
- Local-only roles: the `anon` / `authenticated` roles exist only on dev, test and CI servers (`pnpm db:local:setup`);
  on Cloud SQL the migration skips their revokes automatically.
- Size `DB_POOL_MAX` so instances × pool < Cloud SQL `max_connections`.
- Run `pnpm db:migrate` from a controlled job (Cloud Run job / CI), not on every instance start.

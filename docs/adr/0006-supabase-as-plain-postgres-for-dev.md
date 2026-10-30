# ADR 0006: Supabase as plain PostgreSQL for development and tests

Status: **superseded by [ADR 0011](0011-local-postgres-for-dev-and-tests.md)** (2026-10-29). Kept for the record: the findings below describe the Supabase setup that was used for steps 1-5.

## Context

The team cannot run Docker locally. Production will be Google Cloud SQL (asia-south1). Dev/test needs a real,
hosted Postgres.

## Decision

Use two Supabase projects (`lms-dev`, `lms-test`) **only** as hosted Postgres over the Session pooler (port 5432):
no Supabase Auth, `auth.*`, anon/authenticated roles in our policies, Storage, Realtime, supabase-js or Data API.
Everything stays portable Postgres. Migrations run as the owner (`postgres`); the app runs as `lms_app`.
CI uses a `postgres:17` service container and creates the `anon`/`authenticated` roles first so migrations behave
identically.

## Findings recorded on 2026-10-28 (verified by query)

|                       | lms-dev                                             | lms-test              |
| --------------------- | --------------------------------------------------- | --------------------- |
| Region / pooler       | **eu-west-1** (Ireland)                             | **eu-west-3** (Paris) |
| `SELECT version()`    | PostgreSQL **17.11**                                | PostgreSQL **17.11**  |
| CI / Cloud SQL target | PostgreSQL **18** (newest major Cloud SQL supports) |                       |

Owner role `postgres` on Supabase: `rolsuper = false`, **`rolbypassrls = true`**, `rolcreaterole = true`; member
of `pg_read_all_data`, `pg_monitor`, `anon`, `authenticated`, `service_role`, `supabase_privileged_role`,
`authenticator` and others. Schema `public` is owned by `pg_database_owner`; the `anon` and `authenticated` roles
exist. The migration-created schema `lms` and its tables are owned by `postgres`.

**Consequence for RLS:** on Supabase the owner bypasses RLS, so the migration's conditional `owner_all` policies
(created only when the owner is neither superuser nor BYPASSRLS) are not created there. On Cloud SQL, where
`postgres` is not a superuser, they are created explicitly `TO postgres`, never to `lms_app` or PUBLIC (test
`policies.test.ts`). See `docs/migrating-to-cloud-sql.md`.

## Region decision

The owner chose to keep **dev in eu-west-1** and accepts the extra latency (round trips from India are slow)
for development only; production will be Cloud SQL in asia-south1. The test project ended up in eu-west-3.
Consequences: remote-DB test timeouts are generous (30s/test, 20s connection), the readiness timeout in app config
stays short (2s), and `docs/benchmarks.md` labels DB-dependent numbers as "remote dev DB (eu-west-1), not
representative of production". The API warms its pool at startup so the first readiness probe is not slowed
by the cold TCP+TLS handshake.

## TLS

Supabase's pooler certificate chain is not in Node's trust store. Dev uses `DB_SSL=no-verify` (allowed only when
NODE_ENV is development/test; logs a warning; rejected in production) until the Supabase CA is downloaded and
configured as `DB_SSL=verify-full` with `DB_SSL_CA`.

## Consequences

- Moving to Cloud SQL is a connection-string change plus running migrations (docs/migrating-to-cloud-sql.md).
- Supabase free-tier connection limits require small pools (`DB_POOL_MAX` default 5 in dev/test).

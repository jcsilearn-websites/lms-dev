# Backups, restore and the restore drill (step 14b, part B)

Written for whoever runs the platform in production, and for the person who has to restore it at 3 a.m. Everything here was run, not just
described: `pnpm db:restore-drill` restores a real backup into a throwaway second PostgreSQL cluster and checks the result
(`backend/test/backup.restore-drill.test.ts`, 21 checks, about 45 s locally).

## Two layers, two jobs

| Layer                                                             | Tool                                                            | Kept                                    | Restores to                                     | Use it for                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Point-in-time recovery** (primary on GCP)                       | Cloud SQL: automated backups plus the continuously archived log | **7 days**                              | any second inside the window, as a NEW instance | "we deleted the wrong thing at 14:02", a corrupted table, a bad deploy               |
| **Logical backup** (independent second copy, also the local tool) | `pnpm db:backup` (`pg_dump -Fc` + `pg_dumpall --globals-only`)  | **30 days** (`--keep-days`, default 30) | any PostgreSQL 17 cluster                       | losing the instance or the project, moving cluster, restoring on a laptop, the drill |

The windows are the ones `docs/data-retention.md` and the erasure screens tell members about. A person erased today is still inside every
backup taken before today until it expires (up to 30 days); the **erasure ledger** (below) is what makes them erased again after a restore.

## Targets (proposed: the owner confirms them, and a production-shaped drill measures them)

| Target                              | Proposed value                           | Based on                                                                                                                                          |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** with point-in-time recovery | **5 minutes** or less                    | the log is archived continuously by Cloud SQL (not measured by us; check the instance's `latestRecoveryTime` in a drill)                          |
| **RPO** with the logical backup     | **24 hours** (one dump a night)          | the schedule. Run it more often if the college cannot lose a day of marks.                                                                        |
| **RTO** with point-in-time recovery | **2 hours**                              | a clone takes as long as the database is large; **not measured** (nothing of ours is large yet)                                                   |
| **RTO** with the logical backup     | **4 hours** for a 10,000-student college | **not measured at that size.** Measured: the drill's small test database (dozens of tables with data) restores, verifies and finishes in seconds. |

Do not quote the RTO figures to a college as promises until the drill has run against a database of the size in
`docs/benchmarks.md` (10,000 students x 200 offerings). The scripts print how long each step took; the restore is a single transaction, so the time
is dominated by `pg_restore` of the data and the index builds.

## What a dump does NOT carry (and the trap this caused)

A dump of ONE database holds tables, functions, policies and grants. A **role**, its **password** and its `ALTER ROLE ... SET` **defaults** belong to
the CLUSTER. After a restore into a new cluster:

1. `lms_app` may not exist (the GRANTs of the dump then fail), or exists with **none of its defaults**: `timezone = UTC`, `jit = off` and the two timeouts
   (migrations 0001 and 0058). The drill proves it: restoring the dump alone leaves `pg_db_role_setting` empty for `lms_app`. Without them the application
   would run in the cluster's time zone with JIT on (the bug CI found in step 14a, only visible on a server built with JIT).
2. **The password-fingerprint trap.** `pnpm db:migrate` sets the `lms_app` password only when the fingerprint in `lms.role_password_state` differs from the one
   of the environment. That table is in the dump, so a restored database says "password unchanged" about a role of ANOTHER cluster: the migration skips
   `ALTER ROLE`, the application cannot sign in, and nothing points at the cause. The drill reproduces exactly this (migrate reports `passwordChanged: false`,
   the sign-in is refused with `28P01`).

What protects you, in this order:

- `restore.mjs` **deletes the stored fingerprint** right after `pg_restore`, so the next `db:migrate` or `db:verify-roles --fix` sets the password for certain.
- `pnpm db:verify-roles [--fix]` checks the role by a **real sign-in** with the password of the environment, never by trusting the fingerprint: the role and its
  attributes (`LOGIN`, no superuser, no `BYPASSRLS`, ...), its four defaults, that it owns nothing in `lms`, that a new connection really runs in UTC with
  JIT off, that without a tenant a tenant table is empty, and the trap itself (fingerprint equal, password refused). `--fix` repairs it and checks again.
  The expected state is a SPECIFICATION in `scripts/backup/roles.mjs`, kept equal to the migrations by `backend/test/backup-scripts.unit.test.ts`.
- `globals.sql` (from `pg_dumpall --globals-only`) records the role defaults of the source cluster. `restore.mjs --globals` applies **only** the `ALTER ROLE`
  statements of our three roles from it (never `CREATE ROLE`, `GRANT`, another role, a password or a database-specific setting: unit-tested). It is written
  **without password hashes** unless `db:backup --role-passwords` is given: the application's password comes from the environment, and managed services
  (Cloud SQL) do not allow reading hashes anyway.

## Taking a backup

```
pnpm db:backup --out <directory>            # DATABASE_URL = the OWNER connection (never lms_app); DB_SSL / DB_SSL_CA as everywhere
pnpm db:backup --out <directory> --keep-days 30     # (default) removes backups of this tool older than 30 days; --no-prune keeps all
```

It needs the PostgreSQL 17 `pg_dump` and `pg_dumpall` (`PG_BIN_DIR`, or on `PATH`; another major is refused, and the server must be 17 too).

It writes `<out>/lms-<database>-<UTC time>/`:

| File            | What                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.dump` | `pg_dump -Fc` of the whole database, **from the same snapshot as the counts in the manifest** (`pg_export_snapshot`). UNLOGGED tables (the rate-limit counters, emptied by a crash anyway) are dumped without data.                                                                                                                                   |
| `globals.sql`   | the cluster's roles and their defaults (see above).                                                                                                                                                                                                                                                                                                   |
| `manifest.json` | versions, size and SHA-256 of each file, the **exact row count of every table**, the applied migrations (a digest of file names and checksums), and a digest of every kind of catalog object: tables with their row-security flags, table and column grants, functions (with their `SET` clauses and ACLs), policies, triggers, indexes, constraints. |
| `SHA256SUMS`    | `sha256sum -c` compatible.                                                                                                                                                                                                                                                                                                                            |

The folder is written as `<name>.partial` and renamed when complete, and a refused connection leaves nothing behind (both tested). A password is never an
argument of a process and never printed (tested: the drill searches everything the scripts printed or wrote for each password).

**A backup holds personal data**, so it is stored like the database itself: encrypted, access-controlled, **in a bucket of its own, not the erasure ledger's**
(`docs/production-config.md`), with a lifecycle rule that deletes objects at 30 days. `./backups/` is git-ignored here.

## Restoring

```
RESTORE_DATABASE_URL=postgresql://<owner>:<password>@<host>:5432/<database>  \
  pnpm db:restore --backup <folder> [--globals] [--finish] [--replace --confirm <database>]
```

`RESTORE_DATABASE_URL` is the owner (superuser-capable) connection of the TARGET cluster and names the target database; it is never `DATABASE_URL`, so a
restore is never done into the configured database by accident. Steps, each of which stops the run when it fails:

1. **Every file is checked against the manifest** (SHA-256 and size). A flipped byte or a truncated file is refused, with exit code 3, before the target database
   is even created (tested for both, and for a missing manifest).
2. The target database is created; if it already holds the application it is refused unless `--replace --confirm <its exact name>` is given (it is then dropped).
3. The roles exist (`anon`, `authenticated`, `lms_app` without a password); with `--globals` the defaults of `globals.sql` for those roles are applied.
4. `pg_restore --single-transaction --exit-on-error --no-owner`: all or nothing, and the restoring user owns the objects.
5. The stored password fingerprint is deleted (the trap, above).
6. **The restored database is compared with the manifest**: row counts of every table, row-level security enabled **and forced** on every table of tenant data,
   the applied migrations and their checksums, and the digests of grants, functions, policies, triggers, indexes and constraints; the unlogged tables are empty.
   Any difference exits with code 5 and lists it. `pnpm db:verify-restore --backup <folder>` runs only this step against a database somebody else restored.

With `--finish` (needs `LMS_APP_PASSWORD` and the application's own variables):

7. `db:verify-roles --fix`: the role, its defaults, its password, a real sign-in.
8. `db:migrate`: brings an older backup up to the current schema and checks the migration checksums.
9. `pnpm privacy:reapply-erasures --yes`: **the erasure ledger**. Everyone erased since the backup was taken is erased again. Exit code 2 means an account is
   still waiting for its college's erasure: run it again until it exits 0.

**Do not start the application on a restored database before step 9 has finished.** Until then a person who asked to be forgotten is visible again.

### After a restore: what to check by hand

`SELECT status FROM lms.tenants` (every college back to the state it was in), a sign-in of a test account on each host kind, `GET /health/ready`, the worker's
`/health/ready`, the job queue (`lms.jobs`: queued jobs of the restored moment run again; the idempotency keys of the mail outbox stop a second email for the
same event), and the alert dashboards of `docs/slo.md`.

## Cloud SQL point-in-time recovery

Cloud SQL replaces the dump for the day-to-day cases. Settings (the GCP step applies them; `--database-flags` replaces the whole list, see
`docs/production-config.md`):

```
gcloud sql instances patch <instance> \
  --backup-start-time=18:30 \
  --enable-point-in-time-recovery --retained-transaction-log-days=7 \
  --retained-backups-count=7
```

(18:30 UTC is midnight in India: a quiet hour for the colleges. Check the flag names against the `gcloud` version in use.)

Restoring is a **clone into a new instance** at a chosen second inside the 7 days; the production instance is left alone until the clone has been checked:

```
gcloud sql instances clone <instance> <instance>-restored --point-in-time '2026-12-01T08:29:00Z'
```

Then, against the clone and before any traffic reaches it:

1. check the flags (`jit=off`, `timezone=UTC`) and the `lms_app` role: `pnpm db:verify-roles --fix` (with the clone's owner URL in `DATABASE_URL`). Whether a clone keeps
   the role defaults and the password is **to be confirmed in the GCP drill**; the check is what makes the answer irrelevant.
2. `pnpm db:migrate` (a no-op when the clone is as new as the code).
3. **`pnpm privacy:reapply-erasures --yes`**: a recovery point earlier than an erasure brings the person back exactly like an older dump does.
4. point the API and the worker at the clone (their `DATABASE_URL` / `DATABASE_APP_URL` secrets) or promote it, and watch the readiness probes.

The logical backup is the recovery path for what PITR cannot do: the instance or the project is gone, the 7 days have passed, or the target is not Cloud SQL.

## The erasure ledger and backups

The ledger is **not** in the database and **not** in the backup bucket (`docs/production-config.md`: its own bucket, versioned, retention-locked). A backup is a
copy of the database as it was; a restore takes the database back to that moment, and the ledger is the only record of who was erased after it. The drill shows
the whole story in one run: backup, then erase a person, then restore the OLDER backup into a new cluster (the person is back, with their real name),
then `--finish` (the person is erased again, a bystander and another college are untouched), then run the ledger a second time (nothing more changes).

## What the drill checks (`pnpm db:restore-drill`)

Needs PostgreSQL 17 client tools **and** `initdb` / `pg_ctl` (CI installs them: `.github/scripts/install-postgres-tools.sh`; locally `PG_BIN_DIR` or `PATH`). The test
**fails loudly** without them; a skipped drill would be a drill nobody ran. It is a serial test (it dumps the whole worker database).

1. the backup: the folder, the checksums agree with the files and with `SHA256SUMS`, the manifest counts equal what this test counted itself, the globals carry
   the role defaults and no password hash, a failed backup leaves no folder and prints no password;
2. a damaged backup (flipped byte, truncated file, no manifest) is refused and its target is not created;
3. **negative control**: the dump alone, restored into a hand-made cluster, loses the role defaults and falls into the fingerprint trap (the migration runner skips the
   password, the sign-in is refused); `db:verify-roles` names the trap and the missing defaults and exits 1, `--fix` repairs it, and a real sign-in then shows
   UTC, JIT off, the two timeouts;
4. a proper restore into the bare cluster: every table has the rows it had (counted by the test, not by the scripts), row-level security is enabled and forced on every table
   of tenant data, policies, triggers, functions (`SET` clauses and ACLs; every `SECURITY DEFINER` function keeps its `search_path`) and grants are equal, the migrations are the
   same files with the same checksums and the application's own runner has nothing to apply, every foreign key is present and validated and **no row points at nothing**,
   the unlogged table is empty and still unlogged, and the older backup really does bring the erased person back;
5. `db:verify-restore` agrees, **and has teeth**: forcing row-level security off on one table, changing one function, putting rows in the unlogged table, and deleting a
   row each make it exit 5 with the difference named;
6. a restore over an existing copy is refused without `--replace --confirm <name>`;
7. restore + `--finish`: roles repaired, migrated, the ledger applied (the person erased as in the live database, the bystander and the other college untouched), `lms_app`
   signs in with the environment's password, row-level security works there (no tenant: nothing; tenant A: A's people and none of B's), the audit log is still append-only for
   the application, a `SECURITY DEFINER` function answers, and running the ledger again changes nothing;
8. no password of any of the databases appears in anything the scripts printed or wrote.

## Not covered (so nobody assumes it is)

- Cloud SQL itself: the clone, its flags, the roles after it. It is a step of the GCP drill, with the same `verify-roles` and ledger afterwards.
- The size: the drill's database is small. The RTO needs one run at the benchmark size.
- A restore into a cluster where the owner role has another name than the source's (the owner policies `owner_all` name the owner role): the scripts use the same
  owner name; a different one needs that role created first.
- Object storage (uploaded files, video) is not in the database dump: it has its own versioning and lifecycle in the GCS step (`STORAGE_DRIVER=gcs` is a stub today).
  A restored database that points at files older than the restore point is consistent for the rows it has; files uploaded after the restore point are orphans for the purge job.

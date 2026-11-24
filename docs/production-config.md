# Production configuration (Cloud SQL and friends)

Settings the production environment must carry that no migration or environment variable of the app can enforce on its own.
The deploy checklist of the GCP step starts here.

## Cloud SQL for PostgreSQL 17: database flags

| Flag       | Value | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jit`      | `off` | The planner charges `disable_cost` to plan nodes our functions turn off (`enable_nestloop`, `enable_seqscan`); on a server built with LLVM JIT every inner statement is then JIT-compiled on every call (CI found it: gradebook tests 3-10+ s instead of ms). Small OLTP statements never profit from JIT. The per-function `SET jit = off` (migrations 0049, 0056) and the role default (migration 0058) already cover the app; the instance flag covers the owner role (migrations, `pnpm db:migrate`, ad-hoc work) and any other client. |
| `timezone` | `UTC` | Cloud SQL's default is already UTC; set it explicitly so a changed default can never move dates. `timestamptz + interval` and casts of a `timestamptz` to `date` use the SESSION zone; the app never sets one. Migration 0058 pins `lms_app` to UTC; the flag does the same for every other role. Anything that needs a calendar day or a wall-clock time uses the COLLEGE's zone explicitly (`lms.tenant_tz`, `lms.local_day`, the offering copy).                                                                                         |

```
gcloud sql instances patch <instance> --database-flags=jit=off,timezone=UTC
```

`--database-flags` REPLACES the whole flag list: read the current list first (`gcloud sql instances describe`) and pass every flag.
Setting `timezone` or `jit` needs no restart. The role settings of migration 0058 (`ALTER ROLE lms_app SET ...`) are applied by the
migration itself and need the migrating role to be allowed to alter `lms_app` (the same as the password handling of 0001).

## Verifying after a deploy

```
SHOW jit;        -- off
SHOW timezone;   -- UTC
-- as lms_app on a fresh connection: both again (test/app-role-defaults.test.ts does this against the test database)
```

## Data protection (step 14b): secrets and settings

| Variable                       | Where it lives                                                                                        | Required                                                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPPRESSION_HASH_KEYS`        | **Secret Manager**, mounted as an env var in the API AND the worker (the worker executes the erasure) | **yes, when `NODE_ENV=production`** (the process refuses to start without it) | `kid:secret,kid:secret`, each secret 32+ random characters, ids `[A-Za-z0-9_-]{1,16}`. The keys of the KEYED HASH (HMAC-SHA256, HKDF label `lms.suppression-hash`) that records a suppressed e-mail address once its owner is erased (`email_suppressions.email_hash`, with the id of the key in `email_hash_kid`). A separate secret: never reuse `SIGNING_KEYS`.                                     |
| `ERASURE_LEDGER_DIR`           | a directory (development and CI only)                                                                 | no (default `.erasure-ledger`)                                                | Where the **erasure ledger** is written with the local driver. In production the ledger must live OUTSIDE the database and outside anything a database restore touches: the `gcs` ledger (a bucket with a retention lock and versioning, write-only for the application) is built in the GCP step; until then it answers 503 like the other GCS stubs and an erasure waits instead of being forgotten. |
| `PRIVACY_ERASURE_SCAN_SECONDS` | env                                                                                                   | no (default 300)                                                              | How often the worker executes erasures whose grace period ended, expires undecided requests (30 days) and writes ledger entries.                                                                                                                                                                                                                                                                       |
| `DATA_EXPORT_RATE_PER_HOUR`    | env                                                                                                   | no (default 10)                                                               | Requests an hour, per address, to `POST /me/data-exports` and `POST /me/erasure` (both ask for the password again): the strict, shared limiter.                                                                                                                                                                                                                                                        |

Generate a key: `openssl rand -base64 48`. Create the list as ONE secret value: `k1:<secret>`.

### Rotating `SUPPRESSION_HASH_KEYS` without losing a match

A stored hash cannot be re-keyed (the address is not kept), so an old key must stay as long as any row uses it:

1. Add the new key IN FRONT: `k2:<new>,k1:<old>`, deploy API and worker. New hashes use `k2`; every lookup tries `k2` and `k1`.
2. To know when `k1` may go: `SELECT * FROM lms.privacy_suppression_key_usage();` (key id and the number of rows that carry it).
3. Remove `k1` only when its row count is 0. Removing it earlier makes the suppressions hashed under `k1` unmatchable (an address that bounced could be mailed again).

A leaked key lets whoever has the database also test candidate addresses against the hashes (the usual limit of a hash of a low-entropy value):
rotate it as above, and treat `email_suppressions` as personal data in backups.

### The erasure ledger and a restore

The ledger (ids only: request, membership, user, college, level, time) is what makes an erasure survive a restore of an OLDER backup.
After ANY restore into a production database, once it is migrated and before it takes traffic:

```
pnpm privacy:reapply-erasures --yes
```

It is idempotent. The restore drill (step 14b, backups) includes it. The Cloud SQL backup window (point-in-time recovery 7 days, logical dumps
30 days, see `docs/data-retention.md`) is what the erasure screens tell the member about backups.

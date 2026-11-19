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

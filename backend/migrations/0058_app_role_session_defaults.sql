-- Session defaults of the application role: timezone = 'UTC' and jit = off.
--
-- timezone: the app never set the session zone, so `timestamptz + interval` and every cast of a timestamptz to date or time used the
-- DATABASE's default zone (UTC on Cloud SQL, whatever the machine says on a laptop). Pinning it on the role makes every connection of
-- the API and the worker behave the same on every machine. Code that needs a calendar day or a wall-clock time uses the COLLEGE's zone
-- explicitly (lms.local_day, lms.tenant_tz, the offering copy); the session zone is only the neutral default for everything else.
--
-- jit: the planner charges disable_cost to plan nodes a function turns off, so a server built with LLVM JIT compiles every inner
-- statement (found on CI, migrations 0049 and 0056 fixed the functions one by one). Small OLTP statements never profit from JIT; off
-- for the role is the safe default, and the per-function `SET jit = off` stays (function-jit.test.ts).
--
-- ALTER ROLE ... SET is CLUSTER-wide for the role (like its password) and applies to NEW connections only. A client that sends its
-- own setting at connect time (PGOPTIONS, used by the time-sweep tests) still wins. Cloud SQL: set the same two flags on the
-- instance (docs/production-config.md) so the owner role and any other client agree.
ALTER ROLE lms_app SET timezone = 'UTC';
ALTER ROLE lms_app SET jit = off;

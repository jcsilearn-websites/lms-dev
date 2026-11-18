# ADR 0022: Shared rate limiting (Step 14a)

Status: accepted (Step 14a). Builds on the per-session limits of Step 10 (`core/security.ts`), the authentication limits of
[ADR 0008](0008-own-sessions-and-tenant-from-host.md) and the round-trip budgets in CLAUDE.md. Numbers: `docs/benchmarks.md` (Step 14a).

## Context

Every limiter was in memory, per API instance. With N instances behind the load balancer an attacker (or a runaway client) gets N times
the budget: ten login attempts per minute per address became ten per instance, and a forged-cookie flood counted per instance too. The
limits had to become shared before the first production deployment, **without** adding a database round trip to the hot paths: the exam
autosave and the heartbeat are budgeted at 2 round trips, and the budgets in CLAUDE.md must not move.

## Decision

### An interface, three stores

`RateLimitStore.hit(key, windowMs, delta)` adds hits to a fixed window and returns the total and the time left (`core/rate-limit/store.ts`).

| Store               | Where                   | Use                                                                               |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| memory              | `core/rate-limit`       | development, tests, and the fallback when the shared store fails                  |
| **PostgreSQL**      | `modules/ratelimit`     | **the production default** (`RATE_LIMIT_STORE=postgres`)                          |
| Redis (Memorystore) | `core/rate-limit/redis` | a stub that says why and how: not built (it cannot be tested here without Docker) |

### Why PostgreSQL, not Redis

We already run Cloud SQL, so the limiter adds nothing to operate, secure, size, monitor or pay for. The table is `UNLOGGED` (no WAL, no
replication cost) behind ONE hardened definer function (`lms.rate_limit_hit`, an atomic `INSERT ... ON CONFLICT DO UPDATE`), reachable only
through that function (RLS forced, no policy, no grant: like `user_credentials`). Measured (`bench:ratelimit`, a laptop): 2,500 calls/s one
at a time (p50 0.25 ms) and 5,000/s with 16 at once, 7,500/s on ONE hot key. Redis would be faster per call, but the calls are not what
we pay for (below). **Switch to Redis when the limiter's own statements show up in the Cloud SQL load**, not before: the interface makes it
one file and the contract test (`core/__tests__/store-contract.ts`) is the acceptance test.

**An `UNLOGGED` table is emptied on a crash and on a failover** (PostgreSQL truncates unlogged tables during crash recovery, and they are
not replicated to a standby). That is the intended trade: after a crash or a failover every counter starts again from zero, so for at most
one window (a minute) a limit is more generous than configured. A limiter that forgets everyone for a minute after a database failover
is harmless; a limiter that writes the WAL on every request is not.

### Two tiers (the budgets do not move)

1. **Local tier** (`core/rate-limit/batched.ts`): every route's limit, and the forged-cookie limit. The decision is made **in memory, with
   no database call**: `shared total at the last sync + hits sent but not acknowledged + hits since`. The hits are folded into the shared
   store **in batches, in the background**: when a tenth of the limit has accumulated, or a second has passed and there is something to
   send. The first hit of a window never syncs. The accuracy cost is stated, not hidden: an instance is blind to the others' hits for one
   batch, so N instances together admit about `max + N x max/10`. For limits that exist to stop a runaway client (600 heartbeats a minute,
   900 exam saves a minute) that is fine. Failure of the shared store degrades to per-instance counting and is counted
   (`lms_rate_limit_store_errors_total`); the request is never failed by the limiter.
2. **Strict tier** (`core/rate-limit/strict.ts`): anonymous and authentication endpoints count in the shared store **on every request**:
   `POST /auth/login`, `/auth/password/forgot` (per address and per hashed email), `/auth/password/reset`, `/auth/invites/accept`, the
   email provider webhook, the public unsubscribe calls, `POST /csp-report` and `GET /metrics` (declared with
   `config.strictRateLimit`, enforced by one hook). Here an attacker must not get N times the budget, and these routes are not hot.
   The email address is **hashed** before it becomes a key: the shared table never holds an address.

### The round-trip budgets

The limiter's statement is infrastructure, not part of an endpoint's budget, like the activity touch of Step 12: `statementCounter.count`
in `test/app.ts` excludes `lms.rate_limit_hit` and `.limiter` counts them. `test/rate-limit.shared.test.ts` pins the limiter's own cost:
a high-rate signed-in route costs the limiter **zero** statements on a single request; a strict route costs **one per limiter key**
(login: two, the address and the hashed email; csp-report: one). Every existing budget number is unchanged.

## Consequences

- A strict route is ~4x slower per request than a local one (9,300 -> 2,300 req/s for `POST /csp-report` on the benchmark machine): it is
  one autocommit statement. Only ~10 anonymous routes pay it.
- The purge job `ratelimit.purge` (every minute) removes windows that ended more than a minute ago.
- Behind a proxy the address is `request.ip`: `TRUST_PROXY=true` must be set in production or every request counts against the load
  balancer's address. (This was already true of the per-address limits; it matters more now that a wrong value is shared.)
- Not done: a per-college limit, limits by token for the API (there is no public API key), and the Redis store.

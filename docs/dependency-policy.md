# Dependency policy (Step 14a)

How a dependency enters, how it is kept current, and what stops a vulnerable one. The principle (CLAUDE.md, "Secrets" and the supply-chain
rule): **nothing runs here that has not been public for a while, nothing floats, and a known-bad version fails the build.**

## Entering and pinning

- **Exact versions** for everything we choose (`pnpm add -E`). Ranges (`^`) remain only where they were written before this policy and are
  being converted as packages are touched; the lockfile pins the resolution either way and CI installs with `--frozen-lockfile`.
- **Minimum release age**: pnpm refuses a package published less than about 24 hours ago. It is never bypassed: if `pnpm add` offers to add a
  `minimumReleaseAgeExclude` entry, say no, check `git diff pnpm-workspace.yaml`, and pin an older exact version instead.
- **Review before adding**: what it does, who maintains it, its install scripts (`allowBuilds` in `pnpm-workspace.yaml` lists the few that may run
  one: today only `esbuild`), its transitive weight, and whether Node or the platform already does the job.
- **Peer ranges are respected**: the OpenTelemetry packages are one family (3.x with `@opentelemetry/api` 1.10.x); a mixed set is refused by
  `pnpm peers check`.
- A **runtime** dependency in `backend/` ships in the production image; a **dev** dependency never does (ffmpeg is not even a package).

## Staying current: Renovate (`renovate.json`)

- Runs weekly (Monday before 06:00 IST), `rangeStrategy: pin`, `minimumReleaseAge: 3 days` with `internalChecksFilter: strict` (the age is a
  required check, not advice). Security updates wait **1 day**, the same as pnpm: there is no bypass, even for a CVE (the fix for an
  urgent one is a pinned older safe version or a reviewed exception, not skipping the age).
- Grouped: Tiptap, OpenTelemetry, dnd-kit, GitHub Actions. Majors need approval on the dependency dashboard. `lockFileMaintenance` monthly.
- **Held back on purpose**: TypeScript stays `< 6.1` until dependency-cruiser supports 7; PostgreSQL stays 17 (the code refuses other
  majors); Node stays 24 LTS (a new LTS is a deliberate upgrade, see "CI runner" in CLAUDE.md).
- Every Renovate PR runs the same CI as a person's PR (lint, typecheck, unit + DB tests, E2E, bundle size, Lighthouse, secrets, audit).
  The owner commits and merges; nothing auto-merges.
- Renovate must be **installed on the repository by the owner** (the config is inert until then): a GitHub App or a self-hosted run.

## Failing on known vulnerabilities: `pnpm audit:deps`

`scripts/audit.mjs` runs `pnpm audit` against the public npm registry (the project's mirror has no audit endpoint) and applies the policy in
`backend/src/cli/audit-policy.ts` (unit-tested):

- an advisory of severity **high or critical fails** the build; moderate and below are listed (`--level moderate` makes them fail too);
- the only way past is an entry in **`audit-allowlist.json`**: `id` (GHSA), `package`, a `reason` of 30+ characters (why it does not matter
  here or why it cannot be fixed yet), `reviewedBy`, `reviewed`, and `expires` at most **90 days** after the review;
- an **expired** entry stops covering its advisory and fails the build again; an entry that matches no advisory is reported as **stale**
  (remove it); a malformed entry fails;
- it runs in CI on every push and pull request **and on the nightly schedule**: new advisories appear without any change of ours.

**Fixing is always preferred to excepting.** When this was introduced the report had one high advisory (ReDoS in `ansi-regex` 5.0.0, reached only
through the benchmark tool `autocannon` and Testing Library's `pretty-format`, so dev tooling that never ships); it was fixed with a reviewed
override in `pnpm-workspace.yaml` (`'ansi-regex@5.0.0': 5.0.1`, the patched release of the same line), not excepted. Three moderate
advisories (`uuid` via autocannon, `glob` and `minimatch` via `@fastify/swagger-ui` and Lighthouse) are listed by the gate and are tracked
in Renovate: none is reachable with untrusted input (`@fastify/swagger-ui` is not loaded in production).

## osv-scanner

**Not wired in.** `osv-scanner` reads the lockfile against the OSV database (broader than npm's advisories, includes the GitHub Actions and
the pinned ffmpeg / gitleaks downloads only if listed). It needs a pinned, checksum-verified binary in CI like gitleaks has, and the
version and checksum could not be verified in this session. TODO: add a CI step that installs a pinned release and runs
`osv-scanner --lockfile pnpm-lock.yaml`, with the same exceptions file mapped to `osv-scanner.toml`.

## Checklist when a dependency changes

1. `pnpm install` and `git diff pnpm-workspace.yaml` (no new `minimumReleaseAgeExclude`, no new `allowBuilds`).
2. `pnpm audit:deps`, `pnpm lint`, `pnpm typecheck`, the affected tests; `pnpm bundle:check` for a frontend runtime dependency.
3. A new browser-side library: run the E2E suite: the strict Content-Security-Policy fails it if the library injects a `<style>` element or an
   inline script (Tiptap did; the fix is in ADR 0023).

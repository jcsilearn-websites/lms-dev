# ADR 0012: Frontend stack, same-origin `/api`, bundle budgets

Status: accepted (2026-10-29)

## Context

Step 5b is the first real frontend: sign-in, the college administration screens and the platform area. Students
use phones, a college is a host name (`<slug>.localhost` locally, `<slug>.<domain>` in production) and every screen
must be safe to hide behind permissions without ever being the security boundary.

## Decisions

- **TanStack Router** (code-based route tree, no code generation) with TanStack Query. The members filters live in the
  URL as validated, typed search params (shareable, survive a reload); `defaultPreload: 'intent'` loads a route's code
  and data on hover/focus; every screen except the sign-in page is a lazy chunk. React Router 7 is similar in size but
  weaker on typed search params.
- **Tailwind 4 + components owned in `frontend/src/shared/ui`** (no component library): native `<dialog>` for dialogs
  (focus trap, Escape, backdrop for free), native `<select>`, own toast and table (a list of cards below 768 px, only the
  layout that is shown is rendered). Design tokens are CSS variables; light/dark follow the system with a toggle.
- **Forms**: the backend's TypeBox schemas (`@lms/backend/contracts`) validate in the browser, so a form accepts exactly
  what the API accepts. The public auth forms (sign in, forgot/reset password, accept invite: 1-2 fields) use a tiny
  `useSimpleForm` hook and load the validator lazily on the first field focus; every other form uses react-hook-form with
  a small TypeBox resolver. This keeps react-hook-form (12 KB gzip) and the contracts (19 KB) out of the sign-in page.
- **One origin, every API route under `/api`.** The backend registers all application routes under `/api` (the health probes
  also stay at the root; `/docs` too), because SPA routes such as `/members` would otherwise collide with API routes of the
  same name. The SPA calls `/api/...`; the Vite dev server, `scripts/serve.mjs` (E2E, Lighthouse) and in production the Cloud
  Load Balancer forward `/api/*` to the API **unchanged** (no rewrite, `Host`/`Origin` untouched).
- **Permissions in `/auth/me`** (`permissions: string[]`, from the role map) drive what is shown. Hiding is cosmetic; the
  API enforces everything again.
- **Tenant branding** is a `tenant_settings` row (key `branding`: display name, primary colour as `#rrggbb`); the public
  `GET /tenant/info` returns exactly `{slug, displayName, primaryColor}`. The colour is applied as a CSS variable **per theme and only
  where it has WCAG AA contrast (4.5:1) against that theme's background and allows readable text on top**; otherwise that
  theme keeps its default brand colour.
- **Bundle budgets** (checked by `scripts/check-bundle-size.mjs`, enforced in CI): sign-in page initial load <= **125 KB
  gzip** (React DOM alone is 69 KB, Router 21, Query 15: the original 120 KB target left no room for any application
  code; measured in the Step 5b spike), every route <= 150 KB.
- **E2E** runs against the real API, worker and PostgreSQL in a dedicated database `lms_e2e` (same guards as the test
  databases), with `MAILER=file` for the emailed links.

## Consequences

- The load balancer rule "`/api/*` to the API service, everything else to the SPA, no rewrite" is a production requirement
  (README, "Production routing").
- Dev/E2E need `changeOrigin: false` and the `127.0.0.1` target (Host header for tenant resolution and CSRF; IPv6-first
  `localhost`): both are commented where they are set.
- After the first form interaction the sign-in page loads a 19 KB validation chunk (131 KB in total on that page): an
  accepted trade-off, measured and reported by the bundle check.

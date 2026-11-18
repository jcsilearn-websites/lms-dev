# ADR 0023: A strict Content-Security-Policy and rotatable signing keys (Step 14a)

Status: accepted (Step 14a). Procedure: `docs/key-rotation.md`. Threats these answer: `docs/threat-model.md` (XSS, token theft).

## Part 1: the Content-Security-Policy

### Decision

ONE policy, in ONE module (`backend/src/contracts/csp.ts`, a leaf file with no imports, exported as `@lms/backend/csp`), used by everything
that serves the SPA: the static server of E2E and Lighthouse (`frontend/scripts/serve.mjs` imports it), the production gateway or CDN
(it must send exactly `spaSecurityHeaders()`), and the tests that pin it.

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:;
connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none';
base-uri 'none'; form-action 'self'; report-uri /api/csp-report
```

**No `unsafe-inline`, no `unsafe-eval`, no nonce, no hash.** The reasons it works without them:

- **Scripts**: the Vite build emits only external module scripts. No inline script exists, so no nonce is needed (a nonce would also need a
  server that rewrites the HTML per request, which a static CDN cannot do).
- **Styles**: the app never writes a `style=""` attribute or a `<style>` element. React, the college colour (CSS custom properties) and the
  progress bars set styles **through the CSSOM** (`element.style.x = ...`), which CSP does not restrict. `style-src-attr` and
  `style-src-elem` therefore stay `'self'`, and `15-csp.spec.ts` proves both halves in a real browser: `el.style.color = ...` works and
  `el.setAttribute('style', ...)` is blocked.
- `blob:` in `media-src` (hls.js feeds `<video>` through a MediaSource) and `worker-src` (hls.js's transmuxer; the service worker of Step
  14b is same-origin). Nothing else is opened. `data:` only for images.

The API answers JSON and files, so its own policy is `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
(helmet, with `useDefaults: false`), plus `Cross-Origin-Resource-Policy: same-origin`. Downloads keep their own `sandbox` policy.

### Reporting and enforcement in E2E

`report-uri /api/csp-report` posts violations to a public, strictly rate-limited endpoint (60 per address per minute across every API
instance; 8 KB; `application/csp-report` and `application/reports+json`). It logs the directive, and the blocked and document URLs cut to
`origin/first-path-segment` (query strings, tokens, ids and sample text never reach the log), and counts `lms_csp_violations_total{directive}`
for an alert. A browser cannot send our `Origin` / `X-Requested-With`, so it is the **third** CSRF exemption (`core/csrf.ts`); it creates
nothing, authenticates nothing and answers 204.

The E2E suite fails on any violation in **every** test (`frontend/e2e/support.ts`: an auto fixture watches every context a spec opens for
`securitypolicyviolation` events and Chromium's "Refused to ..." messages). A spec that provokes one on purpose says so
(`expectCspViolation()`). `15-csp.spec.ts` checks the headers, the blocked inline script, the report reaching the API, and the rate limit.

### Cross-Origin-Opener-Policy and Lighthouse

The SPA headers include `Cross-Origin-Opener-Policy: same-origin`. In a headless Lighthouse run it makes the tool lose the main frame: every performance score is 0 while accessibility stays 100. So `pnpm lighthouse` (and only it) serves with `SERVE_OMIT_COOP=1`, which `serve.mjs` turns into `spaSecurityHeaders({ omitCoop: true })`. Production, the E2E suite and every other caller send the header; `csp.unit.test.ts` pins both behaviours. The local Lighthouse numbers are for a page without COOP, which affects navigation isolation only, not loading.

### What a library may not do

If a library starts injecting a `<style>` element or an inline attribute, the E2E suite fails on the report. Fix the library's use (most
have a nonce or a CSSOM option) or replace it; do not loosen the policy. (Tiptap, dnd-kit and hls.js passed unchanged.)

### Production

**The SPA's CSP header must be sent by the production gateway / CDN** (a Cloud Storage backend bucket's custom response headers, or the
load balancer's header policy), with the value of `spaSecurityHeaders()`. The API cannot send it for the SPA: it never serves the HTML.
A deployment check should fetch `/` and `/login` and compare the header with this module (the E2E test does that against `serve.mjs`).
Listed in the GCP TODOs in CLAUDE.md.

## Part 2: signing-key rotation

### Context

Four HMAC schemes signed with one static secret each (playback, deadline receipts, unsubscribe, storage URLs), and no way to change a
secret without breaking every live token: a leaked secret could not be rotated, and a routine rotation would break the 90-day unsubscribe
links in people's mailboxes.

### Decision

A **key ring** (`core/keyring.ts`): `SIGNING_KEYS=kid:secret,kid:secret`, the first signs, all verify. Token format
`v2.<keyId>.<payload>.<mac>`; the MAC covers the purpose and the key id; one HKDF label per purpose, so keys of different purposes are
independent even when the secret is shared; verification looks the key up by id. Rotation = add in front, wait for the longest token
lifetime, remove. Procedure, the emergency path and the removal of the legacy code: `docs/key-rotation.md`.

**Legacy tokens** (issued before key ids) stay verifiable with the key they were signed with, counted by
`lms_legacy_token_verifications_total{purpose}`, behind the flag `SIGNING_LEGACY_TOKENS` (default `on`). The documented removal date is
**90 days after the key-id format ships**, because the unsubscribe token lives 90 days.

### Why not JWT / JOSE

The claims are tiny and fixed, nothing else has to read them, and a bespoke 80-line format with a purpose-bound MAC and no algorithm
negotiation is smaller and safer than a library with `alg` headers. The key id is the one useful idea of `kid`, and we kept it.

## Consequences

- A deployment that sets nothing keeps working (the ring is the one old key as `k0`). Tokens signed after the upgrade are `v2`; a roll-back to
  the previous release would refuse them (a playback or upload URL, a deadline receipt, a not-yet-used unsubscribe link): the same effect
  as any secret change. Roll forward rather than back once mail with new links has gone out.
- Every instance of the API **and the worker** must have the same ring; a mismatched worker signs links the API cannot verify.

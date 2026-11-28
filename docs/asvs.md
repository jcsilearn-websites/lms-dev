# OWASP ASVS Level 2: where we stand (Step 14a)

Standard: OWASP Application Security Verification Standard **4.0.3**, Level 2 (the level for applications that hold personal data and
academic records). This is a **self-assessment** by the engineering team, not an audit: it says what the code does, where a test proves it,
and what is not done. Requirement numbers are those of 4.0.3; where a requirement is covered by the deployment (Cloud Run, the load
balancer, Cloud SQL) and not by this repository it says **platform**. An independent penetration test before the first production college
is still recommended (owner decision).

Legend: **Met** = built and tested | **Met (platform)** = depends on the GCP deployment | **Partial** = part of it | **Gap** = not built
(a TODO below) | **N/A** = does not apply to this application.

## Summary

| Chapter                               | Met | Partial | Gap | N/A | Notes                                                                                                                       |
| ------------------------------------- | --- | ------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------- |
| V1 Architecture, design, threat model | 8   | 2       | 0   | 1   | threat model written (Step 14a); no formal secure-design review process                                                     |
| V2 Authentication                     | 12  | 2       | 2   | 2   | TOTP built, not yet forced by default (step 14c); no breached-password API; minimum length 12 for new and changed passwords |
| V3 Session management                 | 12  | 1       | 0   | 0   |                                                                                                                             |
| V4 Access control                     | 8   | 0       | 0   | 0   | route-table fuzz across tenants                                                                                             |
| V5 Validation, sanitization, encoding | 14  | 1       | 0   | 4   | all SQL by bind parameters; the 20 assembled fragments are reviewed                                                         |
| V6 Stored cryptography                | 7   | 1       | 0   | 1   | key ring and rotation (Step 14a); secrets come from the environment                                                         |
| V7 Error handling and logging         | 8   | 0       | 0   | 0   | log-hygiene test                                                                                                            |
| V8 Data protection                    | 4   | 2       | 2   | 0   | **no data-subject export / erasure yet (Step 14b)**                                                                         |
| V9 Communications                     | 3   | 0       | 0   | 0   | TLS ends at the gateway; database TLS verified in production                                                                |
| V10 Malicious code                    | 3   | 1       | 1   | 0   | **no malware scanning of uploads**                                                                                          |
| V11 Business logic                    | 7   | 0       | 0   | 0   | deadline fairness, idempotency, immutable history                                                                           |
| V12 Files and resources               | 7   | 1       | 1   | 0   | scanning gap as above                                                                                                       |
| V13 API and web service               | 7   | 0       | 0   | 1   | schemas on every route, request and response                                                                                |
| V14 Configuration                     | 9   | 1       | 0   | 0   | dependency audit in CI (Step 14a)                                                                                           |

## V1 Architecture, design and threat modelling

| Req             | Status         | How                                                                                                                              |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.2           | Met            | threat model per module: `docs/threat-model.md`                                                                                  |
| 1.1.4           | Met            | trust boundaries and data flows in the threat model; ADRs 0001-0024                                                              |
| 1.2.x           | Met            | no shared accounts; the app connects as one least-privilege role; the table owner is used only by migrations                     |
| 1.4.x           | Met            | trusted enforcement point is the server: every route declares its permission, services re-check resources, UI hiding is cosmetic |
| 1.5.x           | Met            | input validated at a trusted layer (TypeBox on every route)                                                                      |
| 1.6.x           | Met            | keys: purpose-bound derivation, key ids, rotation procedure (`docs/key-rotation.md`)                                             |
| 1.7.x           | Met            | log format and redaction defined (`config/logger.ts`), tested                                                                    |
| 1.8.x           | Partial        | personal data is classified per table only in Step 14b (`docs/data-retention.md`)                                                |
| 1.9.x           | Met (platform) | all calls over TLS; the database refuses `DB_SSL=off` in production                                                              |
| 1.10.1          | Met            | a git-hooked gitleaks scan and a full-history CI job                                                                             |
| 1.11.x / 1.12.x | Partial        | business-logic limits are documented per module (ADRs); no separate secure-development process document                          |
| 1.14.x          | N/A            | no thick client                                                                                                                  |

## V2 Authentication

| Req                           | Status    | How                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1                         | Met       | minimum length is **12** for NEW and CHANGED passwords (set, reset, invite acceptance, change; `PASSWORD_MIN_LENGTH` in `auth.password-policy.ts`, UI hints, `SEED_USER_PASSWORD`); maximum 128. **Passwords set under the old policy (10-11 characters) stay valid**: login applies no length rule, so nobody is locked out; they are re-validated when changed |
| 2.1.2-2.1.12                  | Met       | 128-character maximum, spaces allowed, NFKC normalisation, no composition rules, no truncation, paste is not blocked, no forced rotation (there is no show-password toggle: 2.1.12 is only partly met)                                                                                                                                                           |
| 2.2.1                         | Met       | per-address and per-hashed-email limits on login, reset and invite acceptance, **shared across instances** (Step 14a); lockout with doubling back-off                                                                                                                                                                                                            |
| 2.2.2-2.2.3                   | Met       | generic failure messages; the account owner is told of a password change by email                                                                                                                                                                                                                                                                                |
| 2.3.x                         | Met       | initial and reset secrets are random 256-bit tokens, single use, expire (7 days / 30 minutes), only SHA-256 stored                                                                                                                                                                                                                                               |
| 2.4.x                         | Met       | argon2id with parameters re-checked at every login (rehash when they change)                                                                                                                                                                                                                                                                                     |
| 2.5.x                         | Met       | reset links are not sent in clear anywhere except the mail itself; a reset revokes every session and never removes the second factor                                                                                                                                                                                                                             |
| 2.6.x / 2.7.x                 | Met / N/A | 2.6 (lookup secrets = recovery codes): 10 codes of 50 bits, single use, stored as keyed hashes, throttled on their own counter. 2.7 (out-of-band): none beyond the emailed single-use links                                                                                                                                                                      |
| 2.8.x                         | **Gap**   | **TOTP built for platform and institution administrators** (step 14c part 1, ADR 0026: encrypted secrets, replay protection, throttling, audit), **mandatory for all of them once `MFA_ENFORCEMENT=required` is the default** (part 3). Still a gap until then; ordinary members cannot opt in                                                                   |
| 2.9.x                         | N/A       | no cryptographic authenticators                                                                                                                                                                                                                                                                                                                                  |
| 2.10.x                        | Met       | no default or hard-coded credentials; the seed refuses production; no secrets in the repository                                                                                                                                                                                                                                                                  |
| password breach check (2.1.7) | **Gap**   | a local list of common passwords only; no k-anonymity lookup against a breach corpus (needs an outbound call and a policy decision)                                                                                                                                                                                                                              |

## V3 Session management

| Req         | Status  | How                                                                                                                                                               |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1       | Met     | the token is never in a URL (a playback token is a different, resource-bound capability, redacted from logs)                                                      |
| 3.2.1-3.2.3 | Met     | a new token at login, 256-bit random, only its hash stored, `HttpOnly`, `Secure`, `__Host-` prefix, `SameSite=Lax`                                                |
| 3.3.1-3.3.4 | Met     | logout, password change, reset and role change revoke sessions; idle (7 d) and absolute (30 d) limits; the user can list and revoke their own sessions            |
| 3.4.x       | Met     | cookie attributes as above; the session is bound to one host (a college's cookie is ignored elsewhere)                                                            |
| 3.5.x       | Partial | no token-based API access exists; a session cache for video segments tolerates a revoked session for at most `VIDEO_SESSION_CACHE_TTL_SECONDS` (60 s), documented |
| 3.7.1       | Met     | sensitive actions (password change) need the current password                                                                                                     |

## V4 Access control

| Req              | Status         | How                                                                                                                                                                                  |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1.1-4.1.3      | Met            | deny by default; permission names, never role strings; enforced on a trusted layer; the app refuses to start with an undeclared route                                                |
| 4.1.5            | Met            | access control fails securely (401 / 403 before body validation)                                                                                                                     |
| 4.2.1-4.2.2      | Met            | object-level checks in the same statement as the work (offering scope, course scope), RLS underneath, CSRF on every state change                                                     |
| 4.3.x            | Met (platform) | admin interfaces are on a separate host; MFA for them is the V2.8 gap                                                                                                                |
| **verification** |                | `authz-matrix.test.ts` (every endpoint x every caller), `offering-scope.test.ts`, **`tenant-fuzz.test.ts`** (every route x every caller of another college, with that college's ids) |

## V5 Validation, sanitization and encoding

| Req          | Status  | How                                                                                                                                                                                |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.x        | Met     | TypeBox schema on every route, request and response; additional properties refused where it matters; pagination bounded                                                            |
| 5.2.x        | Met     | rich text is validated JSON and rendered by components (no HTML sanitizer needed because no HTML is accepted); filenames go through `safeFileName`                                 |
| 5.2.6        | Met     | no server-side requests to user-supplied URLs (a link field is stored and rendered, never fetched)                                                                                 |
| 5.3.x        | Met     | output encoding by React; CSV and XLSX output prefixes formula characters; the API sends `default-src 'none'`; downloads are attachments or sandboxed                              |
| 5.3.4-5.3.5  | Met     | **no SQL by string construction**: bind parameters everywhere; the 20 reviewed fragments are on an allowlist and a static AST check fails on a new one (`sql-concat.unit.test.ts`) |
| 5.3.6-5.3.10 | Met     | no `eval`, no template injection, no OS commands except ffmpeg with fixed arguments and no shell                                                                                   |
| 5.4.x        | Partial | memory-safe language; the 8 MB-per-chunk and 50 MB limits bound buffers; ZIP and CSV are streamed                                                                                  |
| 5.5.x        | Met     | no unsafe deserialization (JSON only, schema-checked)                                                                                                                              |
| V5 N/A       |         | no XML, no GraphQL, no LDAP, no JNDI                                                                                                                                               |

## V6 Stored cryptography

| Req       | Status  | How                                                                                                                                                                          |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1.x     | Partial | data classification arrives with the retention table (Step 14b); encryption at rest is the platform's (Cloud SQL, GCS, CMEK optional)                                        |
| 6.2.x     | Met     | only Node `crypto` primitives and argon2id (`@node-rs/argon2`); no custom algorithms; constant-time comparison                                                               |
| 6.3.x     | Met     | `crypto.randomBytes` for every token and id that must be unguessable; UUIDv7 ids are not secrets and are never used as such (blind-grading keys use random UUIDs on purpose) |
| 6.4.x     | Met     | secrets come from the environment (Secret Manager on GCP), never from the repository; **key rotation without breaking live tokens** (Step 14a)                               |
| 6.2.1 N/A | N/A     | no encrypted-at-the-application-level columns today                                                                                                                          |

## V7 Error handling and logging

| Req   | Status | How                                                                                                                                                       |
| ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1.x | Met    | no credentials, tokens, payment data or personal data in logs: redaction, no bodies, no query strings, **tested over real flows** (`log-hygiene.test.ts`) |
| 7.2.x | Met    | authentication successes and failures, access-control failures and admin actions are logged / audited with request id                                     |
| 7.3.x | Met    | log injection avoided: JSON logging (values are encoded), a request id that is validated or minted                                                        |
| 7.4.x | Met    | generic error bodies with a request id, details only in logs; a last-resort handler never leaks a stack                                                   |

## V8 Data protection

| Req         | Status  | How                                                                                                                                         |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1.1-8.1.2 | Partial | authenticated responses default to **`Cache-Control: no-store`** (Step 14a); the browser holds only the exam queue the design says it holds |
| 8.2.x       | Met     | `localStorage` holds only the durable exam answer queue and the paper (documented, removed when acknowledged); no sensitive data in URLs    |
| 8.3.1       | Met     | sensitive data sent in bodies, not URLs                                                                                                     |
| 8.3.2-8.3.8 | **Gap** | **a member cannot export or erase their data and the retention table does not exist yet: Step 14b** (the India DPDP Act work)               |
| 8.3.x       | Partial | retention jobs exist for sessions, tokens, imports, outbox and notifications; academic history is kept by design                            |

## V9 Communications

| Req   | Status         | How                                                                                                                                                                                                                                           |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1.x | Met (platform) | TLS 1.2+ at the load balancer; `Strict-Transport-Security` is sent by the API and by the SPA headers (`spaSecurityHeaders`)                                                                                                                   |
| 9.2.x | Met            | the API-to-database connection requires `verify-full` with the Cloud SQL CA in production (`off` and `no-verify` are refused); provider calls use HTTPS (`SENDGRID_API_URL` must be `https://`) and SMTP refuses `SMTP_TLS=off` in production |

## V10 Malicious code

| Req         | Status  | How                                                                                                                                        |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.2.x      | Met     | no backdoors or time bombs; the code is reviewed per step; no dynamic code loading                                                         |
| 10.3.x      | Met     | dependencies pinned exactly, 24 h minimum release age, lockfile verified, **audit gate in CI**, Renovate; no auto-update in production     |
| 10.3.2      | Partial | integrity of the SPA bundle is the gateway's; Subresource Integrity is unnecessary (same origin, strict CSP)                               |
| **malware** | **Gap** | **uploaded files are not scanned** (GCS pipeline step, verdict checked at confirm). Highest-risk TODO: before the first production college |

## V11 Business logic

| Req    | Status | How                                                                                                                                                                           |
| ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1.x | Met    | sequential flows enforced server side (attempt lifecycle, gradebook workflow draft -> submitted -> locked), idempotent submits, one active attempt per learner (unique index) |
| 11.1.4 | Met    | anti-automation limits on every route, per session                                                                                                                            |
| 11.1.6 | Met    | no TOCTOU on money-like invariants: the last-admin guard, one import per college, one active attempt are database constraints under locks                                     |
| 11.1.5 | Met    | the deadline is judged by arrival with signed receipts under load (ADR 0018)                                                                                                  |

## V12 Files and resources

| Req    | Status  | How                                                                                                                        |
| ------ | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 12.1.x | Met     | size limits per file and per body, 5 MB CSV, 50 MB files; bounded ZIP generation                                           |
| 12.2.1 | Met     | type checked by extension and **magic bytes** read from the stored bytes, programs and scripts refused by name and content |
| 12.3.x | Met     | stored under keys built from two UUIDs; no path from user input reaches the filesystem; filenames sanitised for download   |
| 12.4.x | Met     | files are served from signed, expiring URLs as attachments (inline only PDF/PNG/JPEG) with `nosniff` and a sandbox CSP     |
| 12.5.x | Met     | no execution of uploaded content on the server; a ZIP in a submission is never opened                                      |
| 12.6.x | Partial | no server-side requests to user-supplied URLs                                                                              |
| 12.4.2 | **Gap** | **antivirus / malware scanning** (see V10)                                                                                 |

## V13 API and web service

| Req           | Status | How                                                                                                                                  |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 13.1.x        | Met    | one JSON API, schema validated (request and response), OpenAPI generated; no mass assignment (typed DTOs, explicit column selection) |
| 13.2.x        | Met    | content types enforced; CSRF defence on every state-changing request with exactly three documented, test-pinned exceptions           |
| 13.3 / 13.4   | N/A    | no SOAP, no GraphQL                                                                                                                  |
| rate limiting | Met    | shared limits (ADR 0022)                                                                                                             |

## V14 Configuration

| Req             | Status  | How                                                                                                                                                                                                                                                                                     |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1.x          | Met     | reproducible build (`pnpm build`), CI on a pinned OS image, pinned dependencies                                                                                                                                                                                                         |
| 14.2.x          | Met     | **dependency audit in CI failing on high / critical with an expiring exception list**; nightly; Renovate with a minimum age (`docs/dependency-policy.md`)                                                                                                                               |
| 14.3.x          | Met     | production errors are generic; debug and the OpenAPI UI are off in production                                                                                                                                                                                                           |
| 14.4.x          | Met     | `Content-Type` with charset, `X-Content-Type-Options: nosniff`, no `X-Powered-By`, **strict CSP** (SPA and API), `Referrer-Policy`, `frame-ancestors 'none'`, `Cross-Origin-Opener-Policy: same-origin` (SPA; only the local Lighthouse run omits it via `SERVE_OMIT_COOP=1`, ADR 0023) |
| 14.5.x          | Met     | HTTP methods restricted per route; CORS restricted to configured origins (none by default: one origin)                                                                                                                                                                                  |
| 14.1.x (config) | Partial | environment validated at start with messages that never echo values; secrets in Secret Manager is a deployment step                                                                                                                                                                     |

## TODO list from this assessment

1. **MFA** (V2.8): TOTP is built (step 14c part 1); make it mandatory with the screens (part 3), add step-up and the reset workflow (part 2). WebAuthn later.
2. **Breached-password check** (V2.1.7): a k-anonymity lookup needs an outbound call and a policy decision. (The 12-character minimum is done.)
3. **Malware scanning of uploads** (V10, V12): GCS finalisation pipeline; before the first production college.
4. **Data subject rights** (V8.3): export and erasure flows, retention table: Step 14b.
5. **Penetration test** by a third party before launch (owner decision); this document is the scoping input.
6. Re-run this assessment when a module is added; the permission doc and the fuzz test update themselves, the rows above do not.

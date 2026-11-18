# Step 14b notes: data protection, backups, load-test harness, service worker

Written 2026-11-18 for a fresh Claude Code session. Step 14a (security review, shared rate limiting, observability, resilience) is done. The next migration number is 0056.

Working rules: follow CLAUDE.md (module layout, query budgets, tests, PostgreSQL 17). Never commit. Finish with a commit plan using plain `git add` commands, verified with `git add -n` so every changed file is covered exactly once.

Start by writing a plan and wait for approval. If the plan is too big for one session, propose a split, for example 14b-1 (data protection) and 14b-2 (backups, load tests, service worker, production config doc).

---

## A. Data protection (India DPDP Act)

### A1. Download my data

- Any member can request an export of their own personal data as a ZIP: profile, enrolments, progress, a list of their own submissions, grades released to them, notification preferences.
- The export never contains other people's data, unreleased grades, grader-only feedback, or accommodation reasons.
- Built by a background job. The file is deleted after 7 days. The download needs a signed-in session. Rate-limited and audited.

### A2. Erasure has TWO levels

1. **College-level**, approved by that college's admin.
   - Erases that college's tenant-scoped personal data: profile fields, activity days, notifications, outbox rows.
   - Shows a pseudonym in THAT college's records through a per-membership display override. Apply it in ONE place: a SQL helper or view used by every query that shows names.
   - The global account stays untouched.
2. **Account-level**, on the person's own request when they have no active memberships left, or by a platform admin.
   - Pseudonymise the global `users` row, revoke all sessions, and make login impossible.

Never let one college's approval change a person's identity or login in another college.

### A3. Decisions to document explicitly (docs/data-retention.md)

- Gradebook snapshots are immutable and hold names and register numbers. Retain them as a legal academic record unless counsel says otherwise, and list them in the erasure preview.
- Scrubbing `audit_log` needs a documented owner-only exception that is itself audited.
- Backups, sent emails and generated exports keep old data until their retention expires. Document each window.

### A4. Erasure request flow

- Password re-entry is required.
- A counts-only preview shows what will be erased and what will be retained, and why.
- Grace period of 7 days by default, with a cancel option. After that it is irreversible.
- College-level requests need that college's admin approval.
- Fully audited. The audit text never contains the erased personal data.

### A5. Docs

- `docs/data-retention.md`: every table that holds personal data, what it holds, the retention window, and how erasure treats it.
- A short note for the client: a privacy notice and consent text are needed, and users under 18 may require verifiable parental consent under DPDP. This needs legal review, not code.

---

## B. Backups

- pg_dump / pg_restore scripts with checksums.
- A restore-drill test that restores into a scratch database and verifies: row counts, RLS still forced, migration checksums, foreign-key integrity, and that the app role can connect.
- Document RPO and RTO targets, and how Cloud SQL point-in-time recovery replaces the dump on GCP.

---

## C. Load-test harness (full-scale run happens later on GCP)

- Put it under `loadtest/`. Use k6 if it can be installed; otherwise a plain Node (undici) fallback.
- Six scenarios:
  1. morning login wave
  2. 1,500-learner exam (start, autosave, submit burst)
  3. assignment deadline burst
  4. 2,000 concurrent video viewers (heartbeats and segment fetches)
  5. instructor grading
  6. general browsing
- Parameterised by base URL, scale and test-tenant credentials. Include a seeding script for a load-test college.
- Run them locally at reduced scale and record the results. Document the full-scale procedure against GCP.

---

## D. Service worker and error boundary

- Service worker caches the app shell and the exam route, so a learner who has already opened an exam can reload and continue offline. The exam answer queue already persists to IndexedDB.
- Versioned caches.
- Update flow: a new version activates safely, with a prompt or on the next navigation.
- Kill switch: a way to unregister all workers remotely.
- Never cache `/api/*`. Clear everything on sign-out.
- Test: deploy a new build while an old service worker is active, and confirm there is no stale shell or API mismatch.
- Register after load, in idle time. Respect the bundle and Lighthouse budgets.
- Global React error boundary, plus rate-limited client error reporting that carries no personal data.

---

## E. Production configuration doc

Write `docs/production-config.md`: every environment variable and secret the production deployment needs (signing keys, metrics token, email provider credentials, database URLs, storage and video providers, and so on), how to generate each, and which are required or optional. GCP setup should then be mechanical.

---

## F. After 14b, and still open

- **Step 14c:** TOTP multi-factor login, mandatory for platform admins and institution admins, with recovery codes.
- Malware scanning of uploads (needs GCP).
- `osv-scanner` in CI.
- Real load test, email provider choice and video provider choice (cost decisions for the client) once GCP work starts.

# ADR 0021: Notifications and real email (Step 13)

Status: accepted (Step 13). Builds on the job queue of [ADR 0010](0010-job-queue-bulk-import-academics.md), the college time zone of
[ADR 0020](0020-analytics-usage.md) and the authentication flows of [ADR 0008](0008-own-sessions-and-tenant-from-host.md).
Numbers: `docs/benchmarks.md` (Step 13). DNS records a college needs: `docs/email-deliverability.md`.

## Context

Until now the app sent four kinds of email, synchronously inside the request (invite, resend, reset, the platform's admin invite), through
a `Mailer` that only logged or wrote a file. Step 13 needs real delivery, ~20 kinds of event, in-app notifications, preferences, quiet
hours and digests, for colleges of 10,000 students. The constraints: an email must never be sent twice because a job retried; an email
must never carry a mark, feedback or a private reason; a fan-out to 10,000 learners must be ONE statement, not a loop; the provider will
be chosen by the client on cost, so nothing outside one folder may know which one it is.

## Decision

### Outbox on our own job queue

Every email is a row in `email_outbox`, inserted **in the same transaction as the event** together with its `email.send` job (a
set-based `INSERT ... SELECT` in `lms.notify_fanout`, or a trigger on the audit row of the auth functions). If the business write rolls
back, the email never existed. The row has a unique key **per (event, recipient)** (`idempotency_key` = the event's dedupe key plus the
recipient: a digest has ONE event key for a whole course, so a key without the recipient queued one email for 60 learners; the Step 13
benchmark found it, and `notifications.scan.test.ts` pins it). The same event twice is a no-op (`ON CONFLICT DO NOTHING`).

The worker (`email.send` queue) does: claim (`lms.email_claim`, one definer call), mint the token of a security mail, render, wait for the
send-rate token, hand to the provider, record (`lms.email_mark`): **2 statements per email**. The claim decides everything that may have
changed since the event: suppression, the member's preference (a change is effective at once, also for mail already queued), active
membership of an active college, quiet hours (a retry that lands inside them is re-queued for their end), the expiry (a 1-hour reminder
is not sent after its deadline). Retries, backoff and the dead letter are the queue's. A **permanent** refusal (SMTP 5xx, SendGrid 400)
ends the row `dead` at once, the last attempt too.

**No secret in the outbox.** An invite or reset token is minted by the worker when it sends (the auth service exposes `mintInviteToken` /
`mintResetToken`), so the database never holds a usable token (`email.delivery.test.ts` greps the outbox). A retry mints a new token and
voids the previous one.

**The one window we cannot close.** If the provider accepted the message and the worker crashed before recording `sent`, the retry sends
again. No SMTP or HTTP provider offers exactly-once delivery. The window is a few milliseconds wide, and it is narrowed: every attempt
carries the **same Message-ID** (`<outbox-id@domain>`), which receiving systems use to collapse duplicates. Every failure BEFORE the
provider accepts retries without a duplicate. This is documented, not hidden.

### Providers behind one interface

`core/mail`: `EmailProvider.send(OutgoingEmail)`. `EMAIL_PROVIDER = smtp | sendgrid | console | file | none` (the old `MAILER` still
works as an alias for one step). `console`, `file` and `none` are refused in production (they log links, write them to disk, or drop mail);
production also requires `EMAIL_FROM_DEFAULT`, a real provider's settings, and TLS for SMTP.

- **SMTP is a first-class path** (nodemailer 10.4.1, pinned exactly; no dependencies of its own): it works with Amazon SES SMTP, Zoho
  ZeptoMail, Mailgun, Postmark, Google Workspace relay, a college's own server. TLS is required (`SMTP_TLS=starttls|implicit`).
- **HTTP API: SendGrid v3** (plain `fetch`, no SDK), the reference adapter: the most widely deployed transactional API, it takes our
  own headers (List-Unsubscribe, Message-ID) and echoes a custom arg (the outbox id) in every webhook event, and its event webhook is
  signed with **ECDSA**: we verify with the public key, so no shared webhook secret exists that could leak. Alternatives weighed: Mailgun
  (HMAC webhooks; a drop-in adapter), Amazon SES (an API call plus SNS certificate verification: more code; its SMTP interface is usable
  today), Postmark (webhooks have no signature).
- The business code never imports a vendor: it calls `notify_fanout` (SQL) or `securityMail.enqueue`.

### Bounce webhooks behind an adapter interface

`BounceWebhookAdapter { provider; verifyAndParse(rawBody, headers) -> normalised events }`. The adapter verifies the signature over the
**raw bytes** (the webhook's JSON parser hands the controller the untouched buffer) and a timestamp window (replay), then turns the
provider's events into `NormalizedEmailEvent { id, kind: bounce | complaint | delivered | deferred | dropped | other, email, ... }`. The
suppression list and everything else only ever see those. SendGrid is the reference adapter (`POST /api/email/webhooks/sendgrid`).
**Adding Amazon SES (via SNS) or Zoho ZeptoMail is one new file plus one line in the registry in `composition.ts`; no business code
changes**: SES = verify the SNS message signature against the AWS signing certificate (the certificate URL must be on
`sns.<region>.amazonaws.com`), `Bounce.bounceType = Permanent` -> bounce, `Complaint` -> complaint; ZeptoMail = its per-webhook secret
(HMAC) header, hard bounce -> bounce, spam complaint -> complaint. Behind a plain SMTP relay there is no bounce feed of our own: the
provider behind the relay posts to the adapter of its own name, and an administrator can always clear or (via support) add entries by hand.

### Suppression list

`email_suppressions` is global by address (a bounce is a fact about an address), with the reason, the time, the provider and the college
whose mail produced it; cleared rows stay as history (`cleared_at`, `cleared_by`). **A hard bounce stops ALL mail to the address,
security mail included** (a dead address hurts every college's reputation and a reset to nowhere is pointless). **A complaint stops
everything except security mail**, so a member can still reset a password. A temporary block (SendGrid `blocked`) is not a bounce. The
signed-in member sees a **banner** ("Emails to <address> are bouncing, contact your college admin"; for a complaint the wording says
only security mail is sent) from `GET /me/email-status`; institution admins see and clear their college's members' entries
(`GET/DELETE /email/suppressions`, audited, scoped inside the definer function to members of that college, never another college's),
platform admins see and clear all of them.

### One-click unsubscribe (RFC 8058)

Non-security mail carries `List-Unsubscribe: <https://<college>/api/notifications/unsubscribe/one-click?t=TOKEN>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, plus a link in the footer to the SPA page `/unsubscribe?t=TOKEN`. The token is
`v1.<base64url(JSON {tenant, user, category, expiry})>.<HMAC-SHA256>`, constant-time compared, 90 days, signed with
`NOTIFY_SIGNING_SECRET` (or a key derived by HKDF with its own label from `STORAGE_SIGNING_SECRET`, like the playback and deadline keys);
nothing about a token is stored. **A GET never changes anything** (link scanners prefetch links): the page shows what would be switched
off and the member confirms with a button. The college in the token must be the college of the host. **Security categories never get a
token and the API refuses them even with a valid MAC.** Unsubscribing switches **email** off for that one category and keeps the bell.

**Two CSRF exemptions, and only two** (CLAUDE.md used to say "nothing is exempt"): the RFC 8058 POST (sent by the MAILBOX PROVIDER, which
cannot send `Origin` or `X-Requested-With`; the token authenticates it) and the provider's webhook (the signature authenticates it). A
route needs BOTH a `csrfExempt` declaration in its config AND its path in the hard-coded list in `core/csrf.ts`;
`route-declarations.test.ts` pins the list, requires both routes to be public, and proves a declaration elsewhere is ignored.

### Templates and privacy

Typed templates (`core/mail/templates.ts`): one description renders HTML and text, so they cannot drift. Every interpolated value is
escaped by the `html` tagged template (a raw value is impossible without constructing a `SafeHtml`), subjects lose CR/LF/control
characters (header injection), display names lose quotes and angle brackets, links are built only from the validated slug and base domain,
the college colour is used only where white text on it passes AA (else a neutral slate). 21 snapshot tests render every template.

**Privacy is structural, not a promise.** The params of a template are TypeBox schemas with `additionalProperties: false` and **no field
for a mark, score, feedback, an extension / accommodation / override reason, or at-risk evidence** (the one boolean is `hasFeedback`, "your
instructor also left feedback"). A param that is not declared makes the row `dead` instead of an email. Emails say "something is ready"
and link to the LMS; the at-risk summary is counts per course and a link, never names. The sentinel test plants a mark, a feedback text
and three kinds of reason, runs every event, and greps every notification, outbox row and email body and header.

### In-app notifications and the bell

`notifications` (per member, RLS on tenant AND `app.user_id`; the app can only set `read_at`), keyset list, mark one / all read,
`dedupe_key` per member. **The bell**: `GET /notifications/unread-count` is the session lookup plus ONE definer call (**2 round trips**),
counts at most 100 over a partial index (the UI shows "99+") and answers an `ETag` built from the count and the newest unread id;
`If-None-Match` gets a **304**. The honest cost: a 304 saves bytes, not the query (the ETag is derived from the same statement), and the
benchmark shows the same throughput for 200 and 304; the saving is the response body and the browser's JSON work. The browser polls
**only while the tab is visible**, every 60 s +-10 %, at once on focus / visibility, every 5 minutes after 30 minutes without input, and
stops for good on 401 / 403 (`notificationPoller.ts`, plain TypeScript, unit tested with fake timers).

**SSE / WebSockets: not now.** At 60 s polling a college of 10,000 open tabs is ~170 requests/s of 2 cheap statements (measured: the
definer alone does ~3,300/s, HTTP ~700/s on a 2-core laptop). SSE would need LISTEN/NOTIFY fan-out per instance and long-held Cloud Run
requests (concurrency and request-timeout limits, a reconnect storm after every deploy). It becomes worth it together with LISTEN/NOTIFY
for the job queue (already a TODO). Platform admins have no college, so they have a small `platform_notifications` inbox read through
definer functions.

### Events, preferences, quiet hours

Seven categories (finer than the four of the brief, so "no content digest but keep deadline reminders" works): `security` (mandatory),
`learning_deadlines`, `learning_grades`, `learning_content`, `teaching_grading`, `teaching_updates`, `admin`. Per member, per category, per
channel (email / in-app); the college sets defaults (`tenant_settings` key `notifications`, institution admins, audited with before and
after). Only a member's OVERRIDES are stored, so a changed college default reaches everybody who chose nothing. Security cannot be turned
off (409 `category_mandatory`); its rows bypass preference, quiet hours and (except a bounce) suppression.

Events come from two places. **Triggers in the transaction of the change** (zero extra round trips): the audit rows the auth, member and
platform functions already write queue invite / reset / password-changed / promotion mail; a released assignment grade (one notification
per handed-in version, whether the release was manual or `immediate`); a quiz result that became visible; an extension or accommodation
(never the reason); the gradebook workflow; a video that finished or failed; an import that finished; a closed usage month. **The scan**
(`notifications.scan`, every `NOTIFY_SCAN_SECONDS`, ONE statement per college, `lms.notify_scan_tenant`) for what happens by the CLOCK:
assignment reminders at 24 h and 1 h **only for learners who have not handed in**, at each learner's own (extended) date; quizzes opening
in 1 h and closing in 24 h / 1 h for learners with no submitted attempt, at the accommodated close; quiz results that became visible when
the close passed; the daily digests (new content, ONE per course per learner per day; work waiting to be graded, one per instructor and
assistant) and the Monday summaries (at-risk counts, course health) at the college's digest hour. A threshold is acted on when it falls in
`(scanned_until, now]` and never more than 24 h back (a worker that was down for a week does not send a week of stale reminders); the
dedupe keys make any overlap harmless. Digests are keyed by the college's LOCAL date, so any number of scans or workers makes one.

Quiet hours (default 22:00-07:00, per college, wrapping midnight, DST-safe: the local end time is converted back with `AT TIME ZONE`)
apply to **email only**; the bell is never silent. An email inside them waits for their end; if that is after the deadline (a 1-hour
reminder at 23:30) the email is dropped (`expired`) and the bell keeps it. Security mail is exempt.

### Performance rules this step applied

- **One statement, no per-learner loop.** `notify_fanout(items[])` writes the in-app rows, the outbox rows and the jobs in one statement;
  the per-college values (settings, time zone, the end of quiet hours) are computed once per college, not per row.
- **Linear without statistics** (a new college has none): the scan finds the few assignments / assessments whose threshold is in the window
  FIRST (one row each, `MATERIALIZED`, course title once per item), then reaches the learners through a `LATERAL ... OFFSET 0` probe of the
  offering's participants with unique-key checks (extension, submission, membership). Measured on a fresh 10,000-student college:
  audience selection 9.4 s -> 0.36 s; analyzed 0.06 s (`docs/benchmarks.md`).
- The suppression check is a unique partial index probe; the outbox is purged after `EMAIL_OUTBOX_RETENTION_DAYS`, read notifications
  after `NOTIFICATIONS_READ_RETENTION_DAYS`, both in bounded batches by definer functions.

## Consequences

- Sending is capped per worker process by a token bucket (`EMAIL_RATE_PER_SECOND`); with N workers the provider sees up to N x that
  number: set it to the provider's limit divided by the number of workers. The bucket is per process (like the rate limiter, TODO: shared).
- The three-way "something happened" (in-app row, outbox row, job) is written by one SQL function, so a new event is: build the audience,
  call `notify_fanout`, add a template with a schema, add a line to the privacy sentinel.
- Mail to a member whose address has no feedback channel behind it (plain SMTP without a provider webhook) is never suppressed
  automatically; the banner and the admin list are fed by the webhook adapters and by hand.
- Not built: new-login alerts (the `security` category is ready), per-learner quiet hours, push notifications, SMS, an unsubscribe-all, a
  shared (Redis) send-rate limiter, open / click tracking (switched off on purpose: it rewrites links and adds pixels).

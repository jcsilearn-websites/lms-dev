# Email deliverability: what JCS and each college must set up

Why this matters: mail that fails SPF / DKIM / DMARC lands in spam, or is refused, and a password reset that never arrives is a support
call. Everything below is DNS and provider configuration; the code only needs the settings in `.env.example` (design: ADR 0021).

## 1. Who sends as whom

| Mail                                           | From                                                     | Reply-To                       |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| Default                                        | `"<College name> via JCS iLearn" <EMAIL_FROM_DEFAULT>`   | the college's reply-to, if set |
| A college with a verified domain               | `"<sender name or college name>" <the verified address>` | the college's reply-to, if set |
| Platform mail (usage closed, admin-host reset) | `"JCS iLearn" <EMAIL_FROM_DEFAULT>`                      | none                           |
- `EMAIL_FROM_DEFAULT` is a JCS-owned address on a **dedicated sub-domain**, e.g. `no-reply@notify.jcs-ilearn.example`. Use a sub-domain,
  not the company's main domain: transactional mail then has its own reputation and DMARC policy, and a problem there cannot hurt
  staff mail.
- A college's **verified From address** (`lms@college.example.edu`) is set by a **JCS platform admin** (`PUT /platform/tenants/:id/email-sender`,
  audited) and only AFTER the steps in section 3 are done for that domain: setting it earlier makes the provider reject the mail
  (an unverified sender). The college itself sets only the sender NAME and the reply-to address (College settings -> Notification
  settings).
- The envelope sender (Return-Path) is the provider's: it handles bounces; that is what makes SPF align (below).

## 2. The JCS sender domain (`notify.jcs-ilearn.example`), done once

Replace the values in `<...>` with what your provider shows in its "domain authentication" screen. Never copy a record from here
verbatim: the DKIM keys are the provider's.

**SPF** (which servers may send for the domain): one TXT record, **one** per name (two SPF records are an error).

```
notify.jcs-ilearn.example.  TXT  "v=spf1 include:<provider's SPF host> -all"
```

Examples of the include: SendGrid `sendgrid.net`, Amazon SES `amazonses.com`, Zoho ZeptoMail `zeptomail.net` (check the provider's page: it
changes). `-all` (hard fail) once you have confirmed that ONLY the provider sends for this sub-domain; start with `~all` while testing.
If the provider uses its own bounce domain (a custom Return-Path / MAIL FROM), SPF is checked on THAT domain, so DMARC alignment then
relies on DKIM: this is normal and fine as long as DKIM is set up.

**DKIM** (a signature the receiver verifies): the provider gives 2 or 3 CNAMEs (SendGrid, SES) or one TXT (Zoho); add them exactly.

```
<selector1>._domainkey.notify.jcs-ilearn.example.  CNAME  <provider's host 1>.
<selector2>._domainkey.notify.jcs-ilearn.example.  CNAME  <provider's host 2>.
```

Then press "Verify" in the provider. The key length must be at least 2048 bits (most providers default to it). Rotate by following the
provider's rotation procedure (they publish the next selector first).

**DMARC** (what to do with mail that fails, and where to send reports): one TXT on `_dmarc.<the sub-domain>`.

```
_dmarc.notify.jcs-ilearn.example.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@jcs-ilearn.example; adkim=s; aspf=r; fo=1"
```

Roll out in three steps, each after at least two weeks of reading the aggregate (`rua`) reports and seeing no legitimate source fail:
`p=none` (monitor) -> `p=quarantine; pct=25` ... `pct=100` -> `p=reject`. `adkim=s` (strict DKIM alignment) works because the From domain
is the domain the provider signs for. Send reports to a mailbox someone reads, or to a DMARC report service.

Also set: **MX** for the sub-domain if replies or bounces should be received there (or leave it without and use Reply-To); a **PTR /
rDNS** is the provider's business on shared IPs (a dedicated IP needs its own PTR and a warm-up: start with the lowest volume and double
it daily).

## 3. A college that wants its own address (`lms@college.example.edu`)

The college's IT team adds records on THEIR domain (or a sub-domain of it, `notify.college.example.edu`, preferred):

1. JCS adds the domain in the provider ("domain authentication") and sends the college the 2-3 DNS records it shows (DKIM CNAMEs, and
   the SPF `include` or the provider's custom Return-Path CNAME).
2. The college publishes them; JCS presses "Verify".
3. The college publishes a DMARC record for the domain, at least `v=DMARC1; p=none; rua=mailto:...`. If the college already has DMARC
   on the main domain, a stricter policy there applies to mail From that domain: that is why the sub-domain is preferred.
4. Only now does a JCS platform admin set the verified From address on the college. A test mail to a Gmail and a Microsoft 365 address
   should show "SPF: PASS, DKIM: PASS, DMARC: PASS" in the message headers (Gmail: "Show original").

If a college does NOT do this, its mail is sent from the JCS default address with the college's name in the display name: it works, but
replies and trust are weaker.

## 4. Bounces, complaints and the suppression list

- **Webhook**: configure the provider to POST its events to `https://<any host that is not a college>/api/email/webhooks/<adapter>`, e.g.
  `https://admin.jcs-ilearn.example/api/email/webhooks/sendgrid`. It is public and CSRF-exempt because the provider cannot send our
  headers: the **signature** authenticates it (SendGrid: ECDSA; paste the PUBLIC key from the SendGrid console into
  `SENDGRID_WEBHOOK_PUBLIC_KEY`; without it the endpoint answers 503). A replayed or forged request is refused (timestamp window
  `EMAIL_WEBHOOK_TOLERANCE_SECONDS`, default 300). Enable the events: Bounced, Dropped, Spam Reports (Delivered and Deferred are optional).
- **What is suppressed**: a **hard bounce** stops ALL mail to that address (security mail too); a **complaint** stops everything except
  security mail; a temporary block (`blocked`, `deferred`) is not suppressed. The member sees a banner in the app; the college's
  institution admins see the list (Notification settings -> Bouncing addresses) and clear an address once it works again; JCS platform
  admins can clear any. Clearing is audited. The suppression reason and time are recorded.
- **Behind plain SMTP** there is no bounce feed of our own. Either the provider behind the SMTP relay posts to the adapter of its own name
  (see below), or bounces are handled in the provider's console and the affected addresses are cleared / entered by hand.

### Adding a provider's webhook (Amazon SES via SNS, Zoho ZeptoMail, Mailgun, ...)

The webhook side is behind a small interface (`core/mail/webhooks.ts`):

```ts
interface BounceWebhookAdapter {
  readonly provider: string;                        // the path segment: POST /api/email/webhooks/<provider>
  verifyAndParse(req: { headers; rawBody: Buffer }, nowMs: number):
    { ok: true; events: NormalizedEmailEvent[] } | { ok: false; reason: 'bad_signature' | 'stale' | ... };
}
```

An adapter verifies the signature over the RAW body and turns the provider's events into `NormalizedEmailEvent` (`bounce`, `complaint`,
`delivered`, `deferred`, `dropped`, `other`). The new file goes next to `sendgrid-webhook.ts`; register it in the `webhooks` array in
`composition.ts`. Nothing else changes: the suppression list, the banner and the admin screens only know the normalised events.

- **Amazon SES**: events arrive as **SNS** notifications (JSON over HTTPS). Verify the SNS message signature with the AWS signing
  certificate (download only from a `https://sns.<region>.amazonaws.com/` URL; check `SignatureVersion`, build the canonical string
  from the fields SNS documents); handle `SubscriptionConfirmation` once; then `Bounce` with `bounceType = Permanent` -> `bounce`,
  `Complaint` -> `complaint`, `Delivery` -> `delivered`. SES also supports SMTP (`email-smtp.<region>.amazonaws.com:587`) today.
- **Zoho ZeptoMail**: a webhook with a secret you set; verify the HMAC it sends in the header against the raw body; hard bounce ->
  `bounce`, spam complaint -> `complaint`. ZeptoMail SMTP (`smtp.zeptomail.com`, user `emailapikey`) works today.
- Mailgun signs with HMAC-SHA256 of `timestamp + token` and a signing key: a ~30-line adapter.

The provider is chosen by the client on cost; **SMTP stays a first-class path**, so a provider can be used the day it is signed up for
(SMTP settings only) and the webhook adapter added when bounce handling is wanted.

## 5. Unsubscribe and security mail

Every non-security email has `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) pointing at the
college's own host, which Gmail and Yahoo require of bulk senders, plus a visible link in the footer. Invitations, password reset and
password-changed mail have neither (they are mandatory). Keep the complaint rate under 0.1 % (Google's bulk-sender guidance): the
digest design (one email per course per day, nothing during quiet hours, reminders only to people who still have something to do) is
what keeps it low.

## 6. Pre-launch checklist

- [ ] SPF, DKIM, DMARC published for the sender domain; the provider shows it as verified.
- [ ] A test mail to Gmail and Microsoft 365: SPF / DKIM / DMARC PASS; it lands in the inbox, not spam; the unsubscribe control appears.
- [ ] `EMAIL_PROVIDER` is `smtp` or `sendgrid`; `EMAIL_FROM_DEFAULT` set; SMTP uses TLS; secrets only in the secret manager.
- [ ] The worker runs (it SENDS the mail); `EMAIL_RATE_PER_SECOND` = the provider's limit / the number of workers.
- [ ] The webhook is configured, its key is set, and a test bounce shows up in Bouncing addresses (and the banner).
- [ ] The DMARC `rua` mailbox is read; the policy is stepped up from `none` only after two clean weeks.
- [ ] Each college that wants its own address went through section 3 before the platform admin set it.

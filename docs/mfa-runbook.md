# Two-step sign-in runbook

For platform administrators (and whoever operates the servers). Design and reasons: `docs/adr/0026-mfa.md`.

## The rules in one table

| Who                                               | Needs two-step sign-in?                                         |
| ------------------------------------------------- | --------------------------------------------------------------- |
| platform administrator, institution administrator | yes, from their next sign-in (`MFA_ENFORCEMENT=required`)       |
| anyone who has set it up and later lost that role | asked until they turn it off (`Sign-in security` -> `Turn off`) |
| other members and instructors                     | no, and they cannot opt in                                      |

**Keep at least three platform administrators** who can sign in. A reset needs one to file it, a second to approve it, and neither may be the
person who lost the factor.

## Setting it up (what to tell an administrator)

1. Sign in with your password. The screen says "Check your email".
2. Open the link within **30 minutes** and enter your password again.
3. Scan the QR code with an authenticator app (or type the key), then enter the 6 digits.
4. **Save the 10 recovery codes** somewhere that is not the phone. They are shown once.

The mail did not arrive: check spam; check the worker is running; check the address is not suppressed (`Settings -> Email`). Signing in again
sends a new link and voids the earlier one.

## Lost phone, still have a recovery code

1. Sign in with your password, choose **Use a recovery code instead**, enter one code.
2. Open **Sign-in security** and choose **Replace authenticator**. The dialog "Confirm it is you" accepts another recovery code.
3. Scan the new QR code and enter its first code. Your other sessions are signed out.
4. Choose **New recovery codes** if few are left.

A code works once. Five wrong recovery codes in a row pause code entry for a minute, doubling up to 15 minutes.

## Lost phone AND recovery codes: the reset

Three different people: **the filer**, **the approver** and **the person**.

1. The person asks. **Confirm their identity by a channel you already trust** (a call to a known number, in person). An e-mail is not enough:
   a person who holds their mailbox and password is exactly who the second factor is meant to stop.
2. Administrator A opens **Two-step sign-in resets** (admin host, account menu), enters the address and files the request.
3. Administrator B opens the same page and **approves**. Both are asked for their own code if they signed in more than 10 minutes ago.
4. **24 hours later** the worker runs it (within about 5 minutes of the hour): the authenticator and codes are removed, every session ends and
   the **password stops working**.
5. The person uses **Forgot your password**, chooses a new one, signs in, and is asked to set up two-step sign-in again.

The person is e-mailed at filing, at approval and at execution. An undecided request **expires after 7 days**. Any platform administrator can
cancel a request that has not run. **If the person signs in with their authenticator or a recovery code, the request is cancelled by itself**:
they did not need it, or somebody else asked for it. In that second case, treat it as an incident (below).

Every step is in the platform audit log and in the audit log of each college the person administers (`auth.mfa_reset_*`).

## Break glass: no two administrators can sign in

Needs access to the server and the **owner** database connection (`DATABASE_URL`). It removes the factor **at once**, without a second person.

```
pnpm mfa:reset --email person@example.com
```

Same effect as an executed reset (factor and codes gone, sessions ended, password invalidated, open request cancelled), audited as
`auth.mfa_reset_break_glass`, and the person is e-mailed. Write down who ran it and why: the audit row has no actor, because the command has no
signed-in user. Then the person chooses a new password with **Forgot your password**.

If nobody can receive mail or no platform administrator exists at all: `pnpm admin:create --email you@example.com` creates (or re-creates) a
platform administrator with a new password and ends that account's sessions. It does **not** remove an existing second factor.

## Somebody else may have the password or the phone

1. Ask the person to reset their password (this ends their sessions and open sign-ins; it does not remove the factor).
2. If the phone or the recovery codes may be exposed: **Replace authenticator** and **New recovery codes**.
3. Read the audit log for `auth.mfa_failed`, `auth.mfa_locked`, `auth.mfa_recovery_used`, `auth.mfa_reset_requested`.
4. An unexpected reset request: cancel it and ask the administrator who filed it how the request reached them.

## The encryption key (`MFA_ENCRYPTION_KEYS`)

**Without it every enrolled administrator is locked out**, and a restored database is useless for them. Keep every version in Secret Manager and
a sealed offline copy apart from the database backups (`docs/production-config.md`, `docs/backup-and-restore.md`).

- **Rotate:** put the new key first (`k2:new,k1:old`), restart the API, run `pnpm mfa:rekey`; remove the old key only when it reports no row
  (recovery codes keep their old key until they are used or replaced).
- **A key is lost:** secrets encrypted under it cannot be read. Restore the key from the offline copy. If there is no copy, every affected
  person needs `pnpm mfa:reset --email ...` (nobody can sign in to file a reset), then a new password and a new set-up.
- **A key leaked:** rotate it, and replace the authenticators of the administrators (a leaked key matters only together with a copy of the
  database).

## Local development and tests

`MFA_ENFORCEMENT` is `required` by default (production refuses `off`). To work without it locally set `MFA_ENFORCEMENT=off` in `.env`. With it on,
the enrolment link is in the mail the **worker** sends (`pnpm dev` runs it; `EMAIL_PROVIDER=console` prints it, `file` writes it).

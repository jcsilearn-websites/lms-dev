# Signing keys: format and rotation (Step 14a)

Every HMAC token the API issues carries a **key id**, and the API holds a **ring** of keys: the first signs, all verify. A key can therefore
be replaced while the tokens it signed are still alive. Design and reasons: [ADR 0023](adr/0023-csp-and-key-rotation.md).

## What is signed

| Purpose (`purpose` in the code) | Token                                       | Lifetime (default)                         | Config today                                          |
| ------------------------------- | ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `playback`                      | video playback session (in the URL path)    | `VIDEO_PLAYBACK_TTL_SECONDS` (2 h)         | `VIDEO_SIGNING_SECRET` or `STORAGE_SIGNING_SECRET`    |
| `receipt`                       | `Deadline-Receipt` of a 503 busy            | `DEADLINE_RECEIPT_WINDOW_SECONDS` (10 min) | `DEADLINE_RECEIPT_SECRET` or `STORAGE_SIGNING_SECRET` |
| `unsubscribe`                   | link in every non-security email            | `UNSUBSCRIBE_TOKEN_DAYS` (**90 days**)     | `NOTIFY_SIGNING_SECRET` or `STORAGE_SIGNING_SECRET`   |
| `storage`                       | signed upload / download URL (local driver) | `STORAGE_URL_TTL_SECONDS` (5 min)          | `STORAGE_SIGNING_SECRET`                              |

The unsubscribe token is the longest-lived: **90 days**. That number decides how long an old key must stay in the ring.

## The format

```
v2.<keyId>.<payload>.<mac>
mac = base64url( HMAC-SHA256( key(keyId, purpose),  "v2." + purpose + "." + keyId + "." + payload ) )
```

- `keyId` matches `[A-Za-z0-9_-]{1,16}`. `payload` is the base64url JSON of the claims (never contains a dot).
- The key of a purpose is **derived** from the configured secret with HKDF and the label `lms.keyring.<purpose>`, so a key of one purpose
  is never valid for another, even when the same secret is configured, and the MAC input names the purpose and the key id as well.
- Verification looks the key up **by id**: an unknown id is refused, and nothing is tried against every key.
- Claims and expiry are checked by each token type after the MAC. Verification is constant-time.

## Configuration

```
SIGNING_KEYS=<newest id>:<secret>,<older id>:<secret>,...        # secrets: 32+ random characters each; the FIRST one signs
SIGNING_LEGACY_TOKENS=on|off                                     # default on, see "Legacy tokens"
```

Without `SIGNING_KEYS` the ring has ONE key under the id `k0`: the per-purpose key of today (the dedicated secret, else HKDF of
`STORAGE_SIGNING_SECRET`). Upgrading changes nothing a deployment has to configure; the format changes, the secrets do not.
Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## The rotation procedure

Rotate on a schedule (every 6-12 months), when someone with access to the secrets leaves, and **at once** when a secret may have leaked.

1. **Add the new key in front**, keep the old one: `SIGNING_KEYS=k2:<new>,k1:<old>`. Deploy API **and worker** (the worker verifies
   unsubscribe tokens it did not sign, and signs the links in the mail it sends). New tokens are signed with `k2`; everything signed with
   `k1` still verifies. Roll the instances one by one: during the roll an instance that has only `k1` refuses a `k2` token, so the
   deployment must finish before step 2 starts being a problem (a refused token is a retry, a 404 or a re-sent link, never data loss).
2. **Wait longer than the longest token lifetime**: 90 days if unsubscribe links must keep working, otherwise 2 hours for everything else.
   `lms_legacy_token_verifications_total` is not the signal here; the age of the oldest mail still being opened is. (After a leak: skip
   the wait, accept that old links stop working.)
3. **Remove the old key**: `SIGNING_KEYS=k2:<new>`. Tokens signed with `k1` are now refused, by design.
4. Record the rotation (date, ids, who) in the operations log. Never put a secret in the repository, a ticket or a log.

**Emergency (a secret leaked):** set `SIGNING_KEYS=k3:<new>` with NO old key, redeploy everything. Every outstanding playback session,
receipt, upload URL and unsubscribe link stops working: players ask for a new session, a retry sends no receipt (and is judged by its own
arrival), uploads are requested again, old unsubscribe links answer "link no longer valid" and the member uses the preference page.

## Legacy tokens (issued before key ids existed)

Tokens in the old format (`<payload>.<mac>`, the unsubscribe `v1.<payload>.<mac>`) are still verified with **the key they were signed
with** (the per-purpose key of the ring's legacy slot) while `SIGNING_LEGACY_TOKENS=on`, so nothing breaks at the upgrade. Every
acceptance increments `lms_legacy_token_verifications_total{purpose}`.

**Removal date: 90 days after the key-id format ships** (the longest-lived token is the 90-day unsubscribe token; every token issued before
that moment has expired by then). Record the ship date here when it is known: `Shipped: ____-__-__  ->  set SIGNING_LEGACY_TOKENS=off on
____-__-__`. Before flipping the flag, look at the counter: it should be flat at zero for a week. After the flip the legacy code path
refuses every old-format token. When the flag has been off for a release, delete the legacy branch (`core/keyring.ts`, `open()`) and the
`legacy` argument of the four token modules.

A rotation while legacy tokens exist: the legacy slot keeps the **old per-purpose key** (it is not part of `SIGNING_KEYS`); it is retired
by flipping the flag, not by editing the ring.

## Tests

`core/__tests__/keyring.unit.test.ts`: rotation mid-flight for every token type, a retired key refused, an unknown key id refused, purposes
are not interchangeable, legacy tokens verify and are counted, the flag turns them off, the `SIGNING_KEYS` parser refuses bad input without
echoing a secret. `test/observability.test.ts` checks the legacy counter reaches `/metrics`.

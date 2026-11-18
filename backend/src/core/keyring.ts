import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// SIGNING-KEY ROTATION (step 14a, docs/key-rotation.md).
//
// Every HMAC token the API issues (playback, deadline receipts, unsubscribe, storage URLs) is sealed as
//     v2.<keyId>.<payload>.<mac>          mac = HMAC-SHA256(key(keyId, purpose), "v2.<purpose>.<keyId>.<payload>")
// The ring holds a CURRENT key (signs) and any number of PREVIOUS keys (verify only), so a key can be rotated while tokens
// signed with the old one are still alive: add the new key in front, wait longer than the longest token lifetime, remove the old one.
//
// Tokens issued before key ids existed ("legacy": `<payload>.<mac>` or `v1.<payload>.<mac>`) stay verifiable with the key they
// were signed with while `SIGNING_LEGACY_TOKENS=on` (default). Every legacy verification increments the metric
// `lms_legacy_token_verifications_total{purpose}`; the flag is switched off 90 days after the key-id format ships (the longest-lived
// token is the 90-day unsubscribe token), see docs/key-rotation.md.

export const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
const MIN_SECRET = 32;

export interface RingKey {
  kid: string;
  /** the purpose-specific key material */
  key: string;
}

export interface KeyRing {
  /** `keys[0]` signs; every entry verifies */
  readonly keys: readonly RingKey[];
  /** the key the unversioned tokens of this purpose were signed with (null: none exist) */
  readonly legacyKey: string | null;
  readonly legacyEnabled: boolean;
}

export interface SigningKeyEntry {
  kid: string;
  secret: string;
}

/** `kid1:secret1,kid2:secret2` -> entries (first = current). Throws on a malformed list; messages never echo secrets. */
export function parseSigningKeys(spec: string | undefined): SigningKeyEntry[] {
  if (!spec) return [];
  const out: SigningKeyEntry[] = [];
  for (const part of spec.split(',')) {
    const i = part.indexOf(':');
    const kid = i > 0 ? part.slice(0, i).trim() : '';
    const secret = i > 0 ? part.slice(i + 1).trim() : '';
    if (!KEY_ID.test(kid)) throw new Error('SIGNING_KEYS: a key id must match [A-Za-z0-9_-]{1,16}');
    if (secret.length < MIN_SECRET) {
      throw new Error(`SIGNING_KEYS: the secret of key "${kid}" must be ${MIN_SECRET}+ characters`);
    }
    if (out.some((e) => e.kid === kid)) throw new Error(`SIGNING_KEYS: duplicate key id "${kid}"`);
    out.push({ kid, secret });
  }
  return out;
}

const derive = (secret: string, purpose: string): string =>
  Buffer.from(hkdfSync('sha256', secret, '', `lms.keyring.${purpose}`, 32)).toString('hex');

/**
 * The ring of one purpose. With SIGNING_KEYS set, the keys are derived (HKDF, one label per purpose) from the configured
 * secrets, so a key of one purpose is never valid for another. Without it the ring is the one legacy key under the id `k0`
 * (no configuration change needed to upgrade).
 */
export function createKeyRing(opts: {
  purpose: string;
  entries?: readonly SigningKeyEntry[];
  /** the key the legacy (unversioned) tokens of this purpose were signed with */
  legacyKey: string | null;
  legacyEnabled?: boolean;
}): KeyRing {
  const entries = opts.entries ?? [];
  const keys: RingKey[] =
    entries.length > 0
      ? entries.map((e) => ({ kid: e.kid, key: derive(e.secret, opts.purpose) }))
      : opts.legacyKey
        ? [{ kid: 'k0', key: opts.legacyKey }]
        : [];
  return { keys, legacyKey: opts.legacyKey, legacyEnabled: opts.legacyEnabled ?? true };
}

/** A string is a one-key ring (tests and tools). */
export function ringOf(purpose: string, keyOrRing: string | KeyRing): KeyRing {
  if (typeof keyOrRing !== 'string') return keyOrRing;
  return createKeyRing({ purpose, legacyKey: keyOrRing });
}

// ---- metrics hook (no dependency on the telemetry module: it registers itself here) ----
let legacyObserver: ((purpose: string) => void) | null = null;
/** The telemetry module registers the counter here. */
export function onLegacyTokenVerified(fn: ((purpose: string) => void) | null): void {
  legacyObserver = fn;
}

const mac = (key: string, purpose: string, kid: string, payload: string): string =>
  createHmac('sha256', key).update(`v2.${purpose}.${kid}.${payload}`).digest('base64url');

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `v2.<kid>.<payload>.<mac>` signed with the current key. `payload` must not contain a dot (base64url never does). */
export function seal(ring: KeyRing, purpose: string, payload: string): string {
  const current = ring.keys[0];
  if (!current) throw new Error(`no signing key for ${purpose}`);
  return `v2.${current.kid}.${payload}.${mac(current.key, purpose, current.kid, payload)}`;
}

export interface Opened {
  payload: string;
  kid: string | null;
  legacy: boolean;
}

export interface LegacyFormat {
  /** the legacy token's leading segment, e.g. `v1` for the unsubscribe tokens (none for the others) */
  prefix?: string;
  /** the legacy MAC (base64url) of a payload under the legacy key */
  mac(key: string, payload: string): string;
}

/**
 * The payload of a genuine token, or null. Accepts the v2 format with any key of the ring, and the legacy format while it is
 * enabled (counting each legacy acceptance). Does NOT look inside the payload: the caller validates claims and expiry.
 */
export function open(
  ring: KeyRing,
  purpose: string,
  token: string,
  legacy: LegacyFormat,
): Opened | null {
  const parts = token.split('.');
  if (parts[0] === 'v2') {
    if (parts.length !== 4) return null;
    const [, kid, payload, given] = parts as [string, string, string, string];
    if (!payload || !given) return null;
    const key = ring.keys.find((k) => k.kid === kid);
    if (!key) return null;
    return same(mac(key.key, purpose, kid, payload), given)
      ? { payload, kid, legacy: false }
      : null;
  }
  if (!ring.legacyEnabled || !ring.legacyKey) return null;
  const want = legacy.prefix ? 3 : 2;
  if (parts.length !== want || (legacy.prefix && parts[0] !== legacy.prefix)) return null;
  const payload = parts[want - 2];
  const given = parts[want - 1];
  if (!payload || !given) return null;
  if (!same(legacy.mac(ring.legacyKey, payload), given)) return null;
  legacyObserver?.(purpose);
  return { payload, kid: null, legacy: true };
}

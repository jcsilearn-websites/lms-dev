import { createHmac, hkdfSync } from 'node:crypto';
import { type KeyRing, open, ringOf, seal } from '../keyring';

/**
 * One-click unsubscribe tokens (RFC 8058). A token names ONE member of ONE college and ONE category, and expires:
 *   v1.<base64url(JSON {t: tenantId, u: userId, c: category, e: expiry epoch seconds})>.<base64url(HMAC-SHA256)>
 * The key is NOTIFY_SIGNING_SECRET or derived (HKDF, own label) from STORAGE_SIGNING_SECRET, like the playback and deadline
 * keys; nothing about a token is stored. Security categories never get a token, and the API refuses them even with a valid MAC.
 */
const LABEL = 'lms-unsubscribe-v1';
const PURPOSE = 'unsubscribe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnsubscribeClaims {
  tenantId: string;
  userId: string;
  category: string;
  /** expiry, epoch seconds */
  exp: number;
}

export function unsubscribeKey(opts: {
  notifySecret?: string | undefined;
  storageSecret?: string | undefined;
}): string {
  if (opts.notifySecret) return opts.notifySecret;
  return Buffer.from(hkdfSync('sha256', opts.storageSecret ?? '', '', LABEL, 32)).toString('hex');
}

export type UnsubscribeVerdict =
  | { ok: true; claims: UnsubscribeClaims }
  | { ok: false; reason: 'malformed' | 'forged' | 'expired' };

export interface UnsubscribeTokens {
  sign(c: Omit<UnsubscribeClaims, 'exp'>, ttlSeconds?: number): string;
  verify(token: string): UnsubscribeVerdict;
}

export function createUnsubscribeTokens(
  secret: string | KeyRing,
  opts: { ttlSeconds: number; now?: () => number },
): UnsubscribeTokens {
  const now = opts.now ?? Date.now;
  const ring = ringOf(PURPOSE, secret);
  return {
    sign(c, ttlSeconds = opts.ttlSeconds) {
      const payload = Buffer.from(
        JSON.stringify({
          t: c.tenantId,
          u: c.userId,
          c: c.category,
          e: Math.floor(now() / 1000) + ttlSeconds,
        }),
      ).toString('base64url');
      return seal(ring, PURPOSE, payload);
    },
    verify(token) {
      if (token.length > 600) return { ok: false, reason: 'malformed' };
      const opened = open(ring, PURPOSE, token, {
        prefix: 'v1',
        mac: (key, payload) =>
          createHmac('sha256', key).update(`v1.${payload}`).digest('base64url'),
      });
      if (!opened) {
        // distinguish a token of the right shape that failed the MAC from a malformed one
        const shape = token.split('.');
        const shaped =
          (shape[0] === 'v2' && shape.length === 4) || (shape[0] === 'v1' && shape.length === 3);
        return { ok: false, reason: shaped ? 'forged' : 'malformed' };
      }
      let raw: { t?: unknown; u?: unknown; c?: unknown; e?: unknown };
      try {
        raw = JSON.parse(Buffer.from(opened.payload, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (
        typeof raw.t !== 'string' ||
        !UUID.test(raw.t) ||
        typeof raw.u !== 'string' ||
        !UUID.test(raw.u) ||
        typeof raw.c !== 'string' ||
        typeof raw.e !== 'number'
      ) {
        return { ok: false, reason: 'malformed' };
      }
      if (raw.e * 1000 <= now()) return { ok: false, reason: 'expired' };
      return { ok: true, claims: { tenantId: raw.t, userId: raw.u, category: raw.c, exp: raw.e } };
    },
  };
}

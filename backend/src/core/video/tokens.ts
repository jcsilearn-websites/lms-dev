import { createHmac, hkdfSync } from 'node:crypto';
import { type KeyRing, open, ringOf, seal } from '../keyring';

// Playback tokens. A token is a capability for ONE asset of ONE tenant, bound to the user it was issued to and
// short-lived. It travels in the URL PATH (`/api/video/play/<token>/master.m3u8`), so the relative URIs inside
// the playlists resolve to the same token without rewriting them. Domain-separated from every other signature
// of the application (a storage URL token can never be a playback token).

export interface PlaybackClaims {
  /** tenant id */
  t: string;
  /** asset id */
  a: string;
  /** user id the session was issued to */
  u: string;
  /** expiry, epoch seconds */
  e: number;
}

const LABEL = 'lms.video.playback.v1';
const PURPOSE = 'playback';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The signing key: the configured one, or derived (HKDF, own label) from the storage key. The environment policy
 * guarantees one of them for a real process (the local provider needs STORAGE_SIGNING_SECRET); a tool that only
 * lists routes (docs:permissions) runs without and never signs anything.
 */
export function playbackKey(opts: {
  videoSecret?: string | undefined;
  storageSecret?: string | undefined;
}): string {
  if (opts.videoSecret) return opts.videoSecret;
  return Buffer.from(hkdfSync('sha256', opts.storageSecret ?? '', '', LABEL, 32)).toString('hex');
}

export interface PlaybackTokens {
  sign(claims: PlaybackClaims): string;
  /** The claims of a genuine, unexpired token; null for anything else. */
  verify(token: string): PlaybackClaims | null;
}

export function createPlaybackTokens(
  secret: string | KeyRing,
  now: () => number = Date.now,
): PlaybackTokens {
  const ring = ringOf(PURPOSE, secret);
  return {
    sign(claims) {
      return seal(ring, PURPOSE, Buffer.from(JSON.stringify(claims)).toString('base64url'));
    },
    verify(token) {
      if (token.length > 1024) return null;
      const opened = open(ring, PURPOSE, token, {
        mac: (key, payload) =>
          createHmac('sha256', key).update(LABEL).update('.').update(payload).digest('base64url'),
      });
      if (!opened) return null;
      try {
        const c = JSON.parse(
          Buffer.from(opened.payload, 'base64url').toString('utf8'),
        ) as PlaybackClaims;
        if (typeof c.e !== 'number' || c.e * 1000 <= now()) return null;
        if (![c.t, c.a, c.u].every((v) => typeof v === 'string' && UUID.test(v))) return null;
        return c;
      } catch {
        return null;
      }
    },
  };
}

/** The `<token>` segment of a playback URL (`/api/video/play/<token>/...`), or null. */
export function tokenOfPlaybackUrl(url: string): string | null {
  const m = /^\/api\/video\/play\/([^/?#]+)/.exec(url);
  return m?.[1] ?? null;
}

/** Playback URLs and tokens are credentials: they must never reach a log line. */
export function redactPlaybackUrl(url: string): string {
  return url.replace(/(\/video\/play\/)[^/?#]+/, '$1[redacted]');
}

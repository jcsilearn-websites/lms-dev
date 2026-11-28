import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238 over HOTP, RFC 4226) as authenticator apps implement it: HMAC-SHA1, 6 digits, 30-second steps (docs/adr/0026-mfa.md).
// Pure: the time is always a parameter, so every boundary is tested with explicit instants. Replay protection is NOT here: the caller
// gets the STEP that matched and the database accepts only a later step than the last accepted one.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** accepted clock drift, in steps, on each side */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the size of the HMAC-SHA1 block output (RFC 4226 section 4) */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): Buffer => randomBytes(TOTP_SECRET_BYTES);

/** The time step an instant belongs to. */
export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step whose code this is, looking at the current step and `TOTP_DRIFT_STEPS` on each side, or null. Every candidate is
 * computed and compared in constant time; when two steps share a code the LATEST is returned.
 */
export function matchTotpStep(secret: Uint8Array, code: string, at: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = totpStep(at);
  let matched: number | null = null;
  for (let step = now - TOTP_DRIFT_STEPS; step <= now + TOTP_DRIFT_STEPS; step++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), given)) matched = step;
  }
  return matched;
}

/** The link an authenticator app reads (the QR code of the enrolment screen encodes exactly this). */
export function otpauthUri(opts: { secret: Uint8Array; account: string; issuer: string }): string {
  const issuer = encodeURIComponent(opts.issuer);
  const label = `${issuer}:${encodeURIComponent(opts.account)}`;
  return (
    `otpauth://totp/${label}?secret=${base32Encode(opts.secret)}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}

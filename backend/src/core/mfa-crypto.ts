import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';
import { parseSigningKeys, type SigningKeyEntry } from './keyring';

// SECRETS OF THE SECOND FACTOR AT REST (step 14c, docs/adr/0026-mfa.md). MFA_ENCRYPTION_KEYS is `kid:secret,kid:secret`: the FIRST
// entry encrypts and hashes, EVERY entry decrypts and is tried. It is a ring of its OWN, not the signing ring: a signing key is retired
// after 90 days, these must live as long as one row refers to them. The keys never reach the database.
//
// Two keys are derived (HKDF, one label each) from an entry: AES-256-GCM for the TOTP secret, HMAC-SHA256 for the recovery codes.
// The TOTP ciphertext is bound to its owner (the user id is the additional authenticated data): a row copied to another person fails.

const SECRET_LABEL = 'lms.mfa.totp-secret';
const RECOVERY_LABEL = 'lms.mfa.recovery-code';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
/** Crockford base32: no I, L, O or U, so a code read from paper cannot be mistyped into another */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface SealedSecret {
  kid: string;
  nonce: Buffer;
  /** ciphertext followed by the 16-byte tag */
  ciphertext: Buffer;
}

export interface RecoveryHash {
  kid: string;
  hash: Buffer;
}

export class MfaKeyError extends Error {}

export function parseMfaKeys(spec: string | undefined): SigningKeyEntry[] {
  try {
    return parseSigningKeys(spec);
  } catch (err) {
    throw new Error(
      (err instanceof Error ? err.message : 'invalid').replace(
        /SIGNING_KEYS/g,
        'MFA_ENCRYPTION_KEYS',
      ),
    );
  }
}

/** `XXXXX-XXXXX` -> `XXXXXXXXXX`; the letters people confuse are read as the digits they stand for. null = not a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return text.length === RECOVERY_CODE_LENGTH &&
    [...text].every((c) => RECOVERY_ALPHABET.includes(c))
    ? text
    : null;
}

export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    let code = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.add(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return [...codes];
}

export function createMfaCrypto(entries: readonly SigningKeyEntry[]) {
  if (entries.length === 0)
    throw new MfaKeyError('MFA_ENCRYPTION_KEYS: at least one key is required');
  const derive = (secret: string, label: string): Buffer =>
    Buffer.from(hkdfSync('sha256', secret, '', label, 32));
  const keys = entries.map((e) => ({
    kid: e.kid,
    cipher: derive(e.secret, SECRET_LABEL),
    mac: derive(e.secret, RECOVERY_LABEL),
  }));
  const current = keys[0] as (typeof keys)[number];

  const hashWith = (key: (typeof keys)[number], code: string): RecoveryHash => ({
    kid: key.kid,
    hash: createHmac('sha256', key.mac).update(code).digest(),
  });

  return {
    currentKid: current.kid,

    seal(userId: string, secret: Uint8Array): SealedSecret {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', current.cipher, nonce);
      cipher.setAAD(Buffer.from(userId));
      const body = Buffer.concat([cipher.update(secret), cipher.final()]);
      return { kid: current.kid, nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
    },

    /** Throws MfaKeyError when the key is not configured, or the row was altered or belongs to somebody else. */
    open(userId: string, sealed: SealedSecret): Buffer {
      const key = keys.find((k) => k.kid === sealed.kid);
      if (!key) throw new MfaKeyError(`MFA_ENCRYPTION_KEYS has no key "${sealed.kid}"`);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key.cipher, sealed.nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(userId));
        decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
        return Buffer.concat([
          decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)),
          decipher.final(),
        ]);
      } catch {
        throw new MfaKeyError('a second-factor secret could not be decrypted');
      }
    },

    /**
     * The hash under the CURRENT key (stored with its key id). `code` must be normalised. The owner is NOT part of the input: the
     * database looks a code up among ONE person's rows, in the same statement that counts and consumes it, before the application
     * knows who is signing in.
     */
    hashRecoveryCode: (code: string): RecoveryHash => hashWith(current, code),

    /** The hash under EVERY configured key: a stored code is looked up with all of them. */
    recoveryCandidates: (code: string): RecoveryHash[] => keys.map((k) => hashWith(k, code)),
  };
}

export type MfaCrypto = ReturnType<typeof createMfaCrypto>;

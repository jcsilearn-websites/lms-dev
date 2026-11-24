import { createHmac, hkdfSync } from 'node:crypto';
import { parseSigningKeys, type SigningKeyEntry } from './keyring';

// The KEYED HASH of an e-mail address (step 14b, data protection): HMAC-SHA256 under a key that lives in the application's
// configuration (SUPPRESSION_HASH_KEYS), never in the database. A plain or unsalted hash of an address can be reversed by
// hashing a list of likely addresses; with a secret key it cannot be done without the key.
//
// KEY ROTATION without losing a match: the list is `kid:secret,kid:secret`, the FIRST key hashes new addresses, EVERY key is tried
// when an address is looked up (`candidates`). A stored hash carries the id of the key it was made with (`email_hash_kid`), so an
// old key is removed only when no row refers to its id any more (the ids in use are counted by `privacy_suppression_key_usage`).
// A stored hash cannot be re-keyed (the address is not kept), so an old key stays as long as one row uses it.

const LABEL = 'lms.suppression-hash';

export interface AddressHash {
  kid: string;
  hash: Buffer;
}

export interface AddressHasher {
  /** the id of the key that hashes new addresses */
  readonly currentKid: string;
  /** the hash under the CURRENT key */
  hash(address: string): AddressHash;
  /** the hash under EVERY configured key: look an address up with all of them */
  candidates(address: string): AddressHash[];
}

export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

/** `SUPPRESSION_HASH_KEYS` -> entries (the same format and rules as SIGNING_KEYS); messages never echo a secret. */
export function parseHashKeys(spec: string | undefined): SigningKeyEntry[] {
  try {
    return parseSigningKeys(spec);
  } catch (err) {
    throw new Error(
      (err instanceof Error ? err.message : 'invalid').replace(
        /SIGNING_KEYS/g,
        'SUPPRESSION_HASH_KEYS',
      ),
    );
  }
}

const keyOf = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, '', LABEL, 32));

export function createAddressHasher(entries: readonly SigningKeyEntry[]): AddressHasher {
  const first = entries[0];
  if (!first) throw new Error('SUPPRESSION_HASH_KEYS: at least one key is required');
  const keys = entries.map((e) => ({ kid: e.kid, key: keyOf(e.secret) }));
  const make = (k: { kid: string; key: Buffer }, address: string): AddressHash => ({
    kid: k.kid,
    hash: createHmac('sha256', k.key).update(normalizeAddress(address)).digest(),
  });
  const current = keys[0] as { kid: string; key: Buffer };
  return {
    currentKid: current.kid,
    hash: (address) => make(current, address),
    candidates: (address) => keys.map((k) => make(k, address)),
  };
}

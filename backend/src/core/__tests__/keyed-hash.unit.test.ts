import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAddressHasher, normalizeAddress, parseHashKeys } from '../keyed-hash';

// The keyed hash of a suppressed address (HMAC-SHA256, key from the configuration): not a plain hash, stable, rotatable.

const S1 = 'a'.repeat(40);
const S2 = 'b'.repeat(40);
const independent = (secret: string, address: string) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', secret, '', 'lms.suppression-hash', 32)))
    .update(address.trim().toLowerCase())
    .digest('hex');

describe('the address hasher', () => {
  const hasher = createAddressHasher(parseHashKeys(`k2:${S2},k1:${S1}`));

  it('is HMAC-SHA256 under a key derived from the secret (an independent computation agrees), 32 bytes', () => {
    const h = hasher.hash('Ada@Example.com ');
    expect(h.kid).toBe('k2');
    expect(h.hash).toHaveLength(32);
    expect(h.hash.toString('hex')).toBe(independent(S2, 'ada@example.com'));
  });

  it('is NOT a plain hash: SHA-256 of the address, of the lower-cased address and of the secret + address all differ', () => {
    const h = hasher.hash('ada@example.com').hash.toString('hex');
    expect(h).not.toBe(createHash('sha256').update('ada@example.com').digest('hex'));
    expect(h).not.toBe(createHash('sha256').update(`${S2}ada@example.com`).digest('hex'));
    expect(h).not.toBe(createHmac('sha256', S2).update('ada@example.com').digest('hex')); // not even HMAC with the raw secret: the key is derived
  });

  it('ignores case and surrounding spaces (the same person, the same hash) and tells different people apart', () => {
    expect(normalizeAddress('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(hasher.hash('ADA@example.com').hash.equals(hasher.hash(' ada@example.com').hash)).toBe(
      true,
    );
    expect(hasher.hash('ada@example.com').hash.equals(hasher.hash('ada@example.org').hash)).toBe(
      false,
    );
  });

  it('a different key gives a different hash: without the key the address cannot be checked', () => {
    const other = createAddressHasher(parseHashKeys(`k9:${'c'.repeat(40)}`));
    expect(other.hash('ada@example.com').hash.equals(hasher.hash('ada@example.com').hash)).toBe(
      false,
    );
  });

  it('ROTATION: new addresses are hashed with the first key, lookups try EVERY key, so a hash made under an old key still matches', () => {
    const before = createAddressHasher(parseHashKeys(`k1:${S1}`));
    const stored = before.hash('ada@example.com'); // made before the rotation: kid k1
    const after = createAddressHasher(parseHashKeys(`k2:${S2},k1:${S1}`));
    expect(after.currentKid).toBe('k2');
    const candidates = after.candidates('ada@example.com');
    expect(candidates.map((c) => c.kid)).toEqual(['k2', 'k1']);
    expect(candidates.some((c) => c.kid === stored.kid && c.hash.equals(stored.hash))).toBe(true);
    // dropping the old key too early loses the match: that is why `privacy_suppression_key_usage` lists the ids still in use
    const dropped = createAddressHasher(parseHashKeys(`k2:${S2}`));
    expect(dropped.candidates('ada@example.com').some((c) => c.hash.equals(stored.hash))).toBe(
      false,
    );
  });
});

describe('the key list', () => {
  it('needs 32+ characters per key, valid unique ids, and names SUPPRESSION_HASH_KEYS in its messages (never a secret)', () => {
    expect(() => parseHashKeys('k1:short')).toThrow(/SUPPRESSION_HASH_KEYS/);
    expect(() => parseHashKeys(`bad id:${S1}`)).toThrow(/SUPPRESSION_HASH_KEYS/);
    expect(() => parseHashKeys(`k1:${S1},k1:${S2}`)).toThrow(/duplicate/);
    try {
      parseHashKeys('k1:short-secret-value');
    } catch (err) {
      expect(String(err)).not.toContain('short-secret-value');
    }
    expect(parseHashKeys(undefined)).toEqual([]);
    expect(() => createAddressHasher([])).toThrow(/at least one key/);
  });
});

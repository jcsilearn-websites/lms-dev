import { describe, expect, it } from 'vitest';
import {
  createMfaCrypto,
  MfaKeyError,
  newRecoveryCodes,
  normalizeRecoveryCode,
  parseMfaKeys,
} from '../mfa-crypto';
import { newTotpSecret } from '../totp';

const OLD = { kid: 'k1', secret: 'a'.repeat(40) };
const NEW = { kid: 'k2', secret: 'b'.repeat(40) };
const USER = '0198d000-0000-7000-8000-000000000001';
const OTHER = '0198d000-0000-7000-8000-000000000002';

describe('the TOTP secret at rest', () => {
  const crypto = createMfaCrypto([OLD]);
  const secret = newTotpSecret();

  it('round-trips, never stores the plain bytes, and uses a new nonce each time', () => {
    const a = crypto.seal(USER, secret);
    const b = crypto.seal(USER, secret);
    expect(crypto.open(USER, a)).toEqual(secret);
    expect(a.kid).toBe('k1');
    expect(a.ciphertext.includes(secret)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('is bound to its owner and to every byte of the row', () => {
    const sealed = crypto.seal(USER, secret);
    expect(() => crypto.open(OTHER, sealed)).toThrow(MfaKeyError);
    for (const field of ['ciphertext', 'nonce'] as const) {
      const broken = Buffer.from(sealed[field]);
      broken[0] = (broken[0] as number) ^ 1;
      expect(() => crypto.open(USER, { ...sealed, [field]: broken }), field).toThrow(MfaKeyError);
    }
    // a truncated tag is refused, not accepted with weaker authentication
    expect(() =>
      crypto.open(USER, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, -4) }),
    ).toThrow(MfaKeyError);
  });

  it('rotation: the new key encrypts, the old one still decrypts; without it the row is unreadable', () => {
    const before = crypto.seal(USER, secret);
    const rotated = createMfaCrypto([NEW, OLD]);
    expect(rotated.open(USER, before)).toEqual(secret);
    expect(rotated.seal(USER, secret).kid).toBe('k2');
    expect(() => createMfaCrypto([NEW]).open(USER, before)).toThrow(/no key "k1"/);
    // the same id with another secret is not the same key
    expect(() =>
      createMfaCrypto([{ kid: 'k1', secret: 'c'.repeat(40) }]).open(USER, before),
    ).toThrow(MfaKeyError);
  });

  it('needs a key, and a malformed list never echoes a secret', () => {
    expect(() => createMfaCrypto([])).toThrow(/MFA_ENCRYPTION_KEYS/);
    expect(() => parseMfaKeys('k1:short')).toThrow(/MFA_ENCRYPTION_KEYS/);
    expect(() => parseMfaKeys('k1:short')).not.toThrow(/short/);
  });
});

describe('recovery codes', () => {
  it('ten distinct codes of the unambiguous alphabet', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('reads what a person types: case, spaces, hyphens and the look-alike letters', () => {
    expect(normalizeRecoveryCode(' abcde-fgh1o ')).toBe('ABCDEFGH10');
    expect(normalizeRecoveryCode('ABCDE FGHIL')).toBe('ABCDEFGH11');
    for (const bad of ['', 'ABCDE', 'ABCDE-FGHJKM', 'ABCDE-FGHJU', 'ABCDE-FGHJ!']) {
      expect(normalizeRecoveryCode(bad), bad).toBeNull();
    }
  });

  it('the hash depends on the key; every configured key is a candidate', () => {
    const one = createMfaCrypto([OLD]);
    const stored = one.hashRecoveryCode('ABCDEFGH10');
    expect(stored.hash).toHaveLength(32);
    expect(one.hashRecoveryCode('ABCDEFGH11').hash.equals(stored.hash)).toBe(false);
    const rotated = createMfaCrypto([NEW, OLD]);
    expect(rotated.hashRecoveryCode('ABCDEFGH10').kid).toBe('k2');
    expect(rotated.hashRecoveryCode('ABCDEFGH10').hash.equals(stored.hash)).toBe(false);
    const match = rotated.recoveryCandidates('ABCDEFGH10').find((c) => c.kid === stored.kid);
    expect(match?.hash.equals(stored.hash)).toBe(true);
  });
});

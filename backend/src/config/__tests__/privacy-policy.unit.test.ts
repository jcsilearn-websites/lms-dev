import { describe, expect, it } from 'vitest';
import { assertPrivacyPolicy, EnvError } from '../env';

// The keyed hash of a suppressed address needs a key of its own in production (SUPPRESSION_HASH_KEYS).

const KEY = `k1:${'x'.repeat(40)}`;

describe('assertPrivacyPolicy', () => {
  it('production without the key is refused, with the key it passes (a list of keys too)', () => {
    expect(() => assertPrivacyPolicy({ NODE_ENV: 'production' })).toThrow(EnvError);
    expect(() =>
      assertPrivacyPolicy({ NODE_ENV: 'production', STORAGE_SIGNING_SECRET: 'y'.repeat(40) }),
    ).toThrow(/SUPPRESSION_HASH_KEYS/);
    expect(() =>
      assertPrivacyPolicy({ NODE_ENV: 'production', SUPPRESSION_HASH_KEYS: KEY }),
    ).not.toThrow();
    expect(() =>
      assertPrivacyPolicy({
        NODE_ENV: 'production',
        SUPPRESSION_HASH_KEYS: `k2:${'z'.repeat(40)},${KEY}`,
      }),
    ).not.toThrow();
  });

  it('a malformed list is refused everywhere, and the message never echoes a secret', () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
      expect(() =>
        assertPrivacyPolicy({
          NODE_ENV,
          SUPPRESSION_HASH_KEYS: 'k1:ten-chars-x',
        }),
      ).toThrow(/SUPPRESSION_HASH_KEYS/);
    }
    try {
      assertPrivacyPolicy({
        NODE_ENV: 'production',
        SUPPRESSION_HASH_KEYS: 'k1:secret-value-that-is-too-short',
      });
    } catch (err) {
      expect(String(err)).not.toContain('secret-value-that-is-too-short');
    }
  });

  it('outside production a key derived from the storage secret is enough (development and tests); with neither it is refused', () => {
    expect(() =>
      assertPrivacyPolicy({ NODE_ENV: 'development', STORAGE_SIGNING_SECRET: 'y'.repeat(40) }),
    ).not.toThrow();
    expect(() => assertPrivacyPolicy({ NODE_ENV: 'development' })).toThrow(/SUPPRESSION_HASH_KEYS/);
  });
});

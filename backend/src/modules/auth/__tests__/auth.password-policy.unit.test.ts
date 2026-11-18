import { describe, expect, it } from 'vitest';
import { assertPasswordAllowed } from '../auth.password-policy';

describe('password policy', () => {
  it('accepts 12-128 characters with no composition rules', () => {
    for (const ok of [
      'xylophone42ab',
      'all lowercase words here',
      'x'.repeat(128),
      '日本語のパスワードです長い文字列',
      '            ',
    ]) {
      expect(() => assertPasswordAllowed(ok), ok).not.toThrow();
    }
  });

  it('rejects too short, too long, and common passwords (case-insensitive)', () => {
    for (const bad of ['', 'short', '123456789', 'xylophone42', 'x'.repeat(129)]) {
      expect(() => assertPasswordAllowed(bad), bad).toThrow(/characters/);
    }
    for (const common of [
      'password1234',
      'PASSWORD1234',
      'Qwerty123456',
      '123456789012',
      'welcome12345',
    ]) {
      expect(() => assertPasswordAllowed(common), common).toThrow(/too common/);
    }
  });

  it('counts code points after NFKC, so 11 emoji are too short but 12 are fine', () => {
    expect(() => assertPasswordAllowed('🔑'.repeat(11))).toThrow();
    expect(() => assertPasswordAllowed('🔑'.repeat(12))).not.toThrow();
  });
});

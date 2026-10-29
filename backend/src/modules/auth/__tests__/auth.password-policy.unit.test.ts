import { describe, expect, it } from 'vitest';
import { assertPasswordAllowed } from '../auth.password-policy';

describe('password policy', () => {
  it('accepts 10-128 characters with no composition rules', () => {
    for (const ok of [
      'xylophone42a',
      'all lowercase words here',
      'x'.repeat(128),
      '日本語のパスワードです長い',
      '           ',
    ]) {
      expect(() => assertPasswordAllowed(ok), ok).not.toThrow();
    }
  });

  it('rejects too short, too long, and common passwords (case-insensitive)', () => {
    for (const bad of ['', 'short', '123456789', 'x'.repeat(129)]) {
      expect(() => assertPasswordAllowed(bad), bad).toThrow(/characters/);
    }
    for (const common of [
      'password123',
      'PASSWORD123',
      'Qwertyuiop',
      '1234567890',
      'iloveyou123',
    ]) {
      expect(() => assertPasswordAllowed(common), common).toThrow(/too common/);
    }
  });

  it('counts code points after NFKC, so 9 emoji are too short but 10 are fine', () => {
    expect(() => assertPasswordAllowed('🔑'.repeat(9))).toThrow();
    expect(() => assertPasswordAllowed('🔑'.repeat(10))).not.toThrow();
  });
});

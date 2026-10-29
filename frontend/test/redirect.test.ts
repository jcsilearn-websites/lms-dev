import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../src/shared/utils/redirect';

describe('safeRedirect (no open redirects through ?redirect=)', () => {
  it('keeps in-app absolute paths, with their query', () => {
    expect(safeRedirect('/members')).toBe('/members');
    expect(safeRedirect('/members?role=member&q=ra')).toBe('/members?role=member&q=ra');
    expect(safeRedirect('/imports/abc')).toBe('/imports/abc');
  });

  it('drops everything that could leave the app or loop', () => {
    for (const bad of [
      'https://evil.test/',
      '//evil.test/path',
      '/\\evil.test',
      'javascript:alert(1)',
      'members',
      '',
      '/login',
      '/login?redirect=/members',
      `/ok${String.fromCharCode(10)}Set-Cookie: x=1`,
      42,
      null,
      undefined,
      { a: 1 },
    ]) {
      expect(safeRedirect(bad), String(bad)).toBeUndefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../errors';
import { prefixPattern } from '../search';

describe('prefixPattern', () => {
  it('lowercases, trims and appends %', () => {
    expect(prefixPattern('  Ra ')).toBe('ra%');
  });

  it('neutralises LIKE wildcards and the escape character (no user-controlled patterns)', () => {
    expect(prefixPattern('50%_off')).toBe('50\\%\\_off%');
    expect(prefixPattern('a\\b')).toBe('a\\\\b%');
  });

  it('rejects terms that are too short after trimming', () => {
    expect(() => prefixPattern(' a ')).toThrow(BadRequestError);
    expect(() => prefixPattern('')).toThrow(BadRequestError);
  });
});

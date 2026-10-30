import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, pgErrorCode } from '../pg-errors';

describe('pgErrorCode', () => {
  it('reads the code through a Drizzle wrapper', () => {
    expect(pgErrorCode({ cause: { code: '23505' } })).toBe('23505');
  });

  it('treats restrict_violation (PostgreSQL 18) like foreign_key_violation', () => {
    expect(isForeignKeyViolation({ code: '23001' })).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: '23503' } })).toBe(true);
    expect(isForeignKeyViolation({ code: '23505' })).toBe(false);
  });
});

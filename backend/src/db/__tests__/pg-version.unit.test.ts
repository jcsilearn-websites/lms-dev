import { describe, expect, it } from 'vitest';
import { assertSupportedPostgres, pgMajorOf, REQUIRED_PG_MAJOR } from '../pg-version';

describe('PostgreSQL version policy', () => {
  it('requires 17', () => {
    expect(REQUIRED_PG_MAJOR).toBe(17);
    expect(pgMajorOf('170010')).toBe(17);
    expect(() => assertSupportedPostgres('170010')).not.toThrow();
    expect(() => assertSupportedPostgres(170000)).not.toThrow();
  });

  it('fails clearly on any other major, older or newer', () => {
    for (const v of ['160011', '180001', '150004', '90600']) {
      expect(() => assertSupportedPostgres(v), v).toThrow(/PostgreSQL 17 is required/);
    }
    expect(() => assertSupportedPostgres('180001')).toThrow(/this server is 18\.1/);
    expect(() => assertSupportedPostgres('nonsense')).toThrow(/PostgreSQL 17 is required/);
  });
});

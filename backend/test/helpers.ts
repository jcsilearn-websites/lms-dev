import { expect } from 'vitest';
import { pgErrorCode as pgCode } from '../src/db/pg-errors';

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected SQLSTATE ${code} but the statement succeeded`).toBeDefined();
  expect(pgCode(caught)).toBe(code);
}

export const SQLSTATE = {
  insufficientPrivilege: '42501',
  foreignKeyViolation: '23503',
  invalidEnum: '22P02',
  uniqueViolation: '23505',
} as const;

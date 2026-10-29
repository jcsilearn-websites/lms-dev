/** SQLSTATE of a pg error, looking through Drizzle's wrapper (DrizzleQueryError.cause). */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === '23505';
export const isForeignKeyViolation = (err: unknown): boolean => pgErrorCode(err) === '23503';

/** True for the check_violation raised by the last-admin trigger (migration 0008). */
export function isLastAdminViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if ((cur as { constraint?: unknown }).constraint === 'tenant_last_admin') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Name of the constraint a pg error refers to, looking through Drizzle's wrapper. */
export function pgConstraint(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const c = (cur as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

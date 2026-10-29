import { COMMON_PASSWORDS } from './auth.common-passwords';
import { WeakPasswordError } from './auth.errors';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Password policy: 10-128 characters and not one of the most common passwords. No composition
 * rules (NIST/OWASP). Length is counted in Unicode code points after NFKC normalisation.
 */
export function assertPasswordAllowed(password: string): void {
  const normalized = password.normalize('NFKC');
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new WeakPasswordError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (COMMON_PASSWORDS.has(normalized.toLowerCase())) {
    throw new WeakPasswordError('This password is too common, choose another one');
  }
}

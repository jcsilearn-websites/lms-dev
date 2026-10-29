import { BadRequestError } from './errors';

/** Emails are stored trimmed and lowercased; everything that looks them up normalizes first. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertValidEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized.length > 320 || !SIMPLE_EMAIL.test(normalized)) {
    throw new BadRequestError('invalid_email', 'Enter a valid email address');
  }
  return normalized;
}

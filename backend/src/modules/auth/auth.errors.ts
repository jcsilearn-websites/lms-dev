import { BadRequestError, TooManyRequestsError, UnauthorizedError } from '../../core/errors';

/** The one error for every failed login: wrong password, unknown email, locked, not a member. */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super('invalid_credentials', 'Invalid email or password');
  }
}

export class InvalidCurrentPasswordError extends BadRequestError {
  constructor() {
    super('invalid_current_password', 'The current password is incorrect');
  }
}

export class WeakPasswordError extends BadRequestError {
  constructor(reason: string) {
    super('weak_password', reason);
  }
}

/** Expired, already used, unknown or wrong-tenant tokens all look the same to the caller. */
export class InvalidTokenError extends BadRequestError {
  constructor() {
    super('invalid_or_expired_token', 'This link is invalid or has expired');
  }
}

export class PasswordRequiredError extends BadRequestError {
  constructor() {
    super('password_required', 'Choose a password to finish setting up your account');
  }
}

// ---- two-factor sign-in (step 14c)

/** Unknown, expired, used up, or from another host: start again with the password. */
export class MfaChallengeInvalidError extends UnauthorizedError {
  constructor() {
    super('mfa_challenge_invalid', 'This sign-in attempt has ended: sign in again');
  }
}

/** A wrong code and an already used one look the same. */
export class MfaCodeInvalidError extends UnauthorizedError {
  constructor() {
    super('mfa_invalid_code', 'That code is not valid');
  }
}

export class MfaCodeRequiredError extends BadRequestError {
  constructor() {
    super('mfa_code_required', 'Send either a code or a recovery code');
  }
}

export class MfaLockedError extends TooManyRequestsError {
  constructor(readonly retryAfterSeconds: number) {
    super('mfa_locked', 'Too many wrong codes: wait before trying again');
  }
}

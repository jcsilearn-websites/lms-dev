import { BadRequestError, UnauthorizedError } from '../../core/errors';

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

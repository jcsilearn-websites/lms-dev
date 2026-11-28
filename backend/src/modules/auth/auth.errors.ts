import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../core/errors';

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

// ---- step-up and the person's own factor (a signed-in person: never a 401, which would mean "you are signed out")

export class MfaWrongCodeError extends BadRequestError {
  constructor() {
    super('mfa_invalid_code', 'That code is not valid');
  }
}

export class MfaSetupEndedError extends BadRequestError {
  constructor() {
    super('mfa_challenge_invalid', 'This setup has ended: start again');
  }
}

export class MfaNotEnrolledError extends ConflictError {
  constructor() {
    super('mfa_not_enrolled', 'Two-step sign-in is not set up for this account');
  }
}

export class MfaCannotDisableError extends ConflictError {
  constructor() {
    super('mfa_required', 'Your role requires two-step sign-in: it cannot be turned off');
  }
}

// ---- the four-eyes reset

export class MfaResetNotFoundError extends NotFoundError {
  constructor() {
    super('mfa_reset_not_found', 'Reset request not found');
  }
}

export class MfaResetAccountNotFoundError extends NotFoundError {
  constructor() {
    super('account_not_found', 'No account with this address');
  }
}

export class MfaResetConflictError extends ConflictError {
  constructor(
    code:
      | 'mfa_reset_self'
      | 'mfa_reset_self_approval'
      | 'mfa_not_enrolled'
      | 'mfa_reset_in_progress'
      | 'mfa_reset_not_pending'
      | 'mfa_reset_expired'
      | 'mfa_reset_too_late',
  ) {
    super(code, MFA_RESET_MESSAGES[code]);
  }
}

const MFA_RESET_MESSAGES = {
  mfa_reset_self: 'Another platform administrator has to file the reset of your own account',
  mfa_reset_self_approval: 'The filer, the approver and the person must be three different people',
  mfa_not_enrolled: 'This account has no second factor to reset',
  mfa_reset_in_progress: 'A reset of this account is already open',
  mfa_reset_not_pending: 'This request is not waiting for a decision',
  mfa_reset_expired: 'This request was not decided in time and has expired',
  mfa_reset_too_late: 'This request can no longer be cancelled',
} as const;

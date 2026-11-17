import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';

/** Security mail (invites, password reset / changed) cannot be switched off. */
export class CategoryMandatoryError extends ConflictError {
  constructor() {
    super('category_mandatory', 'Security emails cannot be switched off');
  }
}

/** Forged, malformed, of another college, or expired: one code, the message only says whether it expired. */
export class InvalidUnsubscribeLinkError extends BadRequestError {
  constructor(expired: boolean) {
    super(
      'unsubscribe_link_invalid',
      expired
        ? 'This unsubscribe link has expired. Change your email settings after signing in.'
        : 'This unsubscribe link is not valid.',
    );
  }
}

export class UnsubscribeNotMemberError extends NotFoundError {
  constructor() {
    super('unsubscribe_link_invalid', 'This unsubscribe link is not valid.');
  }
}

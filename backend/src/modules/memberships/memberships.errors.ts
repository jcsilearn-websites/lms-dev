import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';

export class InvalidMembershipRoleError extends BadRequestError {
  constructor() {
    super('invalid_membership_role', "Role must be 'institution_admin' or 'member'");
  }
}

export class MembershipNotFoundError extends NotFoundError {
  constructor() {
    super('membership_not_found', 'Membership not found');
  }
}

export class MembershipAlreadyExistsError extends ConflictError {
  constructor() {
    super('membership_already_exists', 'The user is already a member of this tenant');
  }
}

export class MemberNotFoundError extends NotFoundError {
  constructor() {
    super('member_not_found', 'Member not found');
  }
}

/** An admin may not demote, suspend or remove their own membership. */
export class CannotModifySelfError extends ConflictError {
  constructor() {
    super('cannot_modify_self', 'You cannot change your own role or membership');
  }
}

/** A tenant must always keep at least one ACTIVE institution admin (enforced by a DB trigger). */
export class LastAdminError extends ConflictError {
  constructor() {
    super('last_admin', 'A college must keep at least one active institution admin');
  }
}

export class MemberNotActiveError extends ConflictError {
  constructor() {
    super('member_not_active', 'Only an active member can be suspended');
  }
}

export class MemberNotSuspendedError extends ConflictError {
  constructor() {
    super('member_not_suspended', 'The member is not suspended');
  }
}

export class MemberNotPendingError extends ConflictError {
  constructor() {
    super('member_not_pending', 'The member has already accepted the invite');
  }
}

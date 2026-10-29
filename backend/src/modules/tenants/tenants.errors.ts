import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';

export class TenantNotFoundError extends NotFoundError {
  constructor() {
    super('tenant_not_found', 'Tenant not found');
  }
}

export class TenantSettingNotFoundError extends NotFoundError {
  constructor() {
    super('tenant_setting_not_found', 'Tenant setting not found');
  }
}

export class InvalidSlugError extends BadRequestError {
  constructor() {
    super(
      'invalid_slug',
      'The slug must be 3-63 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen',
    );
  }
}

export class ReservedSlugError extends BadRequestError {
  constructor() {
    super('reserved_slug', 'That slug is reserved');
  }
}

export class SlugTakenError extends ConflictError {
  constructor() {
    super('slug_taken', 'A college with that slug already exists');
  }
}

export class AlreadyInstitutionAdminError extends ConflictError {
  constructor() {
    super(
      'already_institution_admin',
      'That person is already an institution admin of this college',
    );
  }
}

export class InviteeSuspendedError extends ConflictError {
  constructor() {
    super('member_suspended', 'That person is suspended in this college: reactivate them first');
  }
}

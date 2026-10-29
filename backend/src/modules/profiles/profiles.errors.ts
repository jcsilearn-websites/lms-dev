import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';

export class ProfileNotFoundError extends NotFoundError {
  constructor() {
    super('profile_not_found', 'This member has no profile yet');
  }
}

export class SectionNotFoundError extends NotFoundError {
  constructor() {
    super('section_not_found', 'The section does not exist or is archived');
  }
}

export class InvalidProfileValueError extends BadRequestError {
  constructor(details: { path: string; message: string }[]) {
    super('invalid_value', 'Some fields are invalid', details);
  }
}

export class NothingToUpdateError extends BadRequestError {
  constructor() {
    super('nothing_to_update', 'Send at least one field to change');
  }
}

export class ProfileTypeRequiredError extends BadRequestError {
  constructor() {
    super('profile_type_required', 'profileType is required to create a profile');
  }
}

/** Students carry register number / batch / section; faculty and staff carry employee id / department. */
export class ProfileFieldsMismatchError extends BadRequestError {
  constructor() {
    super(
      'profile_fields_mismatch',
      'Students use registerNumber, batchId and sectionId; faculty and staff use employeeId and departmentId',
    );
  }
}

export class InvalidProfileReferenceError extends BadRequestError {
  constructor() {
    super(
      'invalid_reference',
      'The department, batch or section does not exist in this college (a section must belong to the batch)',
    );
  }
}

export class DuplicateProfileKeyError extends ConflictError {
  constructor(field: 'register_number' | 'employee_id') {
    super(
      `duplicate_${field}`,
      field === 'register_number'
        ? 'That register number belongs to another member'
        : 'That employee id belongs to another member',
    );
  }
}

export class ProfileParentArchivedError extends ConflictError {
  constructor() {
    super('parent_archived', 'The batch or section is archived');
  }
}

/** Translates the database's constraint errors (migration 0012) into API errors; null = not one of ours. */
export function mapProfileDbError(err: unknown): Error | null {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err) ?? '';
  if (code === '23505') {
    return new DuplicateProfileKeyError(
      constraint === 'member_profiles_employee_key' ? 'employee_id' : 'register_number',
    );
  }
  if (code === '23503') return new InvalidProfileReferenceError();
  if (code === '23502') return new ProfileTypeRequiredError();
  if (code === '23514') {
    if (constraint === 'parent_archived') return new ProfileParentArchivedError();
    if (constraint === 'member_profiles_type_fields') return new ProfileFieldsMismatchError();
    if (constraint === 'member_profiles_section_needs_batch') {
      return new InvalidProfileValueError([{ path: 'sectionId', message: 'needs a batchId' }]);
    }
    return new InvalidProfileValueError([{ path: '', message: 'a value is not allowed' }]);
  }
  return null;
}

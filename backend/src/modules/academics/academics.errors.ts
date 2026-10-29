import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';

export class AcademicNotFoundError extends NotFoundError {
  constructor(singular: string) {
    super('academic_not_found', `The ${singular} was not found`);
  }
}

export class InvalidAcademicValueError extends BadRequestError {
  constructor(details: { path: string; message: string }[]) {
    super('invalid_value', 'Some fields are invalid', details);
  }
}

export class NothingToUpdateError extends BadRequestError {
  constructor() {
    super('nothing_to_update', 'Send at least one field to change');
  }
}

export class DuplicateAcademicError extends ConflictError {
  constructor(what: 'label' | 'code' | 'name' | 'batch') {
    super(
      `duplicate_${what}`,
      what === 'batch'
        ? 'That program already has a batch for that admission year'
        : `That ${what} is already in use`,
    );
  }
}

export class TermOverlapError extends ConflictError {
  constructor() {
    super('term_overlap', 'The term overlaps another term of the same academic year');
  }
}

export class TermOutsideYearError extends BadRequestError {
  constructor() {
    super('term_outside_year', 'A term must lie within its academic year');
  }
}

export class InvalidReferenceError extends BadRequestError {
  constructor() {
    super('invalid_reference', 'A referenced parent does not exist in this college');
  }
}

/** Hard delete refused: history depends on the row (archive it instead). */
export class AcademicInUseError extends ConflictError {
  constructor() {
    super('in_use', 'Something still refers to this record: archive it instead of deleting it');
  }
}

export class HasActiveChildrenError extends ConflictError {
  constructor() {
    super('has_active_children', 'Archive the active records below it first');
  }
}

export class ParentArchivedError extends ConflictError {
  constructor() {
    super('parent_archived', 'The parent is archived: unarchive it first');
  }
}

export class CurrentYearArchivedError extends ConflictError {
  constructor() {
    super('current_year_archived', 'The current academic year cannot be archived');
  }
}

export class AlreadyInStateError extends ConflictError {
  constructor(code: 'already_archived' | 'not_archived') {
    super(code, code === 'already_archived' ? 'It is already archived' : 'It is not archived');
  }
}

/** Translates the database's constraint errors (migration 0011) into API errors; null = not one of ours. */
export function mapAcademicsDbError(err: unknown, op: 'write' | 'delete'): Error | null {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err) ?? '';
  if (code === '23505') {
    if (constraint === 'academic_years_label_key') return new DuplicateAcademicError('label');
    if (constraint === 'terms_name_key') return new DuplicateAcademicError('name');
    if (constraint === 'batches_year_key') return new DuplicateAcademicError('batch');
    return new DuplicateAcademicError('code');
  }
  if (code === '23P01') return new TermOverlapError();
  if (code === '23503')
    return op === 'delete' ? new AcademicInUseError() : new InvalidReferenceError();
  if (code === '23514') {
    switch (constraint) {
      case 'archive_has_active_children':
        return new HasActiveChildrenError();
      case 'parent_archived':
        return new ParentArchivedError();
      case 'terms_within_year':
        return new TermOutsideYearError();
      case 'academic_years_current_not_archived':
        return new CurrentYearArchivedError();
      case 'academic_years_dates_check':
      case 'terms_dates_check':
        return new InvalidAcademicValueError([
          { path: 'endDate', message: 'must be after the start date' },
        ]);
      case 'batches_years_check':
        return new InvalidAcademicValueError([
          { path: 'graduationYear', message: 'must be after the admission year' },
        ]);
      default:
        return new InvalidAcademicValueError([{ path: '', message: 'a value is not allowed' }]);
    }
  }
  return null;
}

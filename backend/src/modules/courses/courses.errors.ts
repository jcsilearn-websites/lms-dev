import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';

export class CourseNotFoundError extends NotFoundError {
  constructor() {
    super('course_not_found', 'The course does not exist');
  }
}

/** Also what a member who does not take part in the offering gets: its existence is not revealed. */
export class OfferingNotFoundError extends NotFoundError {
  constructor() {
    super('offering_not_found', 'The offering does not exist');
  }
}

export class ParticipantNotFoundError extends NotFoundError {
  constructor() {
    super('participant_not_found', 'That person does not take part in this offering');
  }
}

export class OfferingSectionNotFoundError extends NotFoundError {
  constructor() {
    super(
      'section_not_found',
      'The section does not exist, is archived, or is not in this offering',
    );
  }
}

export class DuplicateCourseCodeError extends ConflictError {
  constructor() {
    super('duplicate_code', 'Another course already uses this code');
  }
}

export class DuplicateOfferingError extends ConflictError {
  constructor() {
    super('duplicate_offering', 'This course already has an offering with this label in this term');
  }
}

export class SectionAlreadyAddedError extends ConflictError {
  constructor() {
    super('already_added', 'This section is already part of the offering');
  }
}

export class CourseHasOfferingsError extends ConflictError {
  constructor() {
    super('has_active_children', 'Archive the offerings of this course first');
  }
}

export class CourseParentArchivedError extends ConflictError {
  constructor() {
    super('parent_archived', 'The course or the term is archived');
  }
}

export class InvalidCourseReferenceError extends BadRequestError {
  constructor() {
    super('invalid_reference', 'The department, course, term or section does not exist');
  }
}

export class OfferingArchivedError extends ConflictError {
  constructor() {
    super('offering_archived', 'The offering is archived and can no longer be changed');
  }
}

export class InvalidStatusChangeError extends ConflictError {
  constructor(from: string, to: string) {
    super('invalid_status', `An offering cannot go from ${from} to ${to}`);
  }
}

export class NothingToChangeError extends BadRequestError {
  constructor() {
    super('nothing_to_update', 'Send at least one field to change');
  }
}

/** Translates the database's constraint errors (migration 0016) into API errors; null = not one of ours. */
export function mapCourseDbError(err: unknown): Error | null {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err) ?? '';
  if (code === '23505') {
    if (constraint === 'courses_code_key') return new DuplicateCourseCodeError();
    if (constraint === 'course_offerings_run_key') return new DuplicateOfferingError();
    if (constraint === 'offering_sections_pkey') return new SectionAlreadyAddedError();
    return null;
  }
  if (code === '23503') return new InvalidCourseReferenceError();
  if (code === '23514') {
    if (constraint === 'archive_has_active_children') return new CourseHasOfferingsError();
    if (constraint === 'parent_archived') return new CourseParentArchivedError();
  }
  return null;
}

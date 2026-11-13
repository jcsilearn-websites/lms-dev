import {
  BadRequestError,
  ConflictError,
  type ErrorDetail,
  ForbiddenError,
  NotFoundError,
} from '../../core/errors';

export class GradebookNotFoundError extends NotFoundError {
  constructor() {
    super('gradebook_not_found', 'This offering has no gradebook');
  }
}

export class GradebookLockedError extends ConflictError {
  constructor(status: string) {
    super(
      'gradebook_locked',
      status === 'locked'
        ? 'This gradebook is locked: an administrator has to unlock it before it can change'
        : 'This gradebook is waiting for approval: it cannot change until it is approved or returned',
    );
  }
}

export class GradebookNotReadyError extends ConflictError {
  readonly problems: { code: string; message: string; items?: string[] }[];
  constructor(problems: { code: string; message: string; items?: string[] }[]) {
    super('gradebook_not_ready', problems.map((p) => p.message).join(' '));
    this.problems = problems;
  }
}

export class InvalidGradebookError extends BadRequestError {
  constructor(details: ErrorDetail[], message = 'The gradebook settings are not valid') {
    super('invalid_gradebook', message, details);
  }
}

export class CategoryInUseError extends ConflictError {
  constructor(name: string) {
    super('category_in_use', `The category "${name}" has items; move or remove them first`);
  }
}

export class NotSubmittedError extends ConflictError {
  constructor() {
    super('gradebook_not_submitted', 'This gradebook is not waiting for approval');
  }
}

export class NotLockedError extends ConflictError {
  constructor() {
    super('gradebook_not_locked', 'Only a locked gradebook can be unlocked');
  }
}

export class SelfApprovalError extends ForbiddenError {
  constructor() {
    super(
      'self_approval_not_allowed',
      'You submitted this gradebook, so you cannot approve or return it yourself. Ask another administrator, or ask the college to allow self-approval.',
    );
  }
}

export class LearnerNotInClassError extends NotFoundError {
  constructor() {
    super('learner_not_found', 'This learner is not in the class of the offering');
  }
}

export class GradebookItemNotFoundError extends NotFoundError {
  constructor() {
    super('gradebook_item_not_found', 'This item is not in the gradebook');
  }
}

export class InvalidMarkError extends BadRequestError {
  constructor(max: number) {
    super('invalid_mark', `A mark must be between 0 and ${max}, with at most two decimals`);
  }
}

export class NoOverrideError extends NotFoundError {
  constructor() {
    super('override_not_found', 'There is no override here to remove');
  }
}

export class MarkImportNotFoundError extends NotFoundError {
  constructor() {
    super('mark_import_not_found', 'This marks import does not exist (it may have expired)');
  }
}

export class MarkImportDoneError extends ConflictError {
  constructor() {
    super('mark_import_done', 'This marks import was already applied');
  }
}

export class MarkImportHasErrorsError extends ConflictError {
  constructor(cells: number) {
    super(
      'mark_import_has_errors',
      `${cells} cell(s) have errors. Fix the file, or apply it and skip the rows with errors.`,
    );
  }
}

export class InvalidMarksCsvError extends BadRequestError {
  constructor(message: string, details?: ErrorDetail[]) {
    super('invalid_marks_csv', message, details);
  }
}

export class NoSnapshotError extends NotFoundError {
  constructor() {
    super('no_locked_version', 'This gradebook has no approved (locked) version to export yet');
  }
}

export class GradeScaleNotFoundError extends NotFoundError {
  constructor() {
    super('grade_scale_not_found', 'This grade scale does not exist');
  }
}

export class GradeScaleNameTakenError extends ConflictError {
  constructor() {
    super('grade_scale_name_taken', 'Another grade scale of this college has this name');
  }
}

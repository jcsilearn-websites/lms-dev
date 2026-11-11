import { BadRequestError, ConflictError, type ErrorDetail, NotFoundError } from '../../core/errors';

export class AssignmentNotFoundError extends NotFoundError {
  constructor() {
    super('assignment_not_found', 'This assignment does not exist or is not open to you');
  }
}

export class LearnerNotFoundError extends NotFoundError {
  constructor() {
    super('learner_not_found', 'This learner is not in the class of the assignment');
  }
}

export class AssignmentFileNotFoundError extends NotFoundError {
  constructor() {
    super('file_not_found', 'This file does not exist');
  }
}

export class InvalidAssignmentSettingsError extends BadRequestError {
  constructor(message: string) {
    super('invalid_assignment_settings', message);
  }
}

export class AssignmentNotOpenError extends ConflictError {
  constructor() {
    super('assignment_not_open', 'This assignment is not open yet');
  }
}

export class AssignmentClosedError extends ConflictError {
  constructor() {
    super(
      'assignment_closed',
      'This assignment is closed: the due date and the late period are over',
    );
  }
}

export class AlreadySubmittedError extends ConflictError {
  constructor() {
    super('already_submitted', 'This assignment accepts only one submission and you have made it');
  }
}

export class SubmissionTypeNotAllowedError extends BadRequestError {
  constructor(what: 'text' | 'link' | 'files') {
    super('submission_type_not_allowed', `This assignment does not accept ${what}`);
  }
}

export class EmptySubmissionError extends BadRequestError {
  constructor() {
    super('empty_submission', 'Add a file, some text or a link before you hand in');
  }
}

export class TooManyFilesError extends BadRequestError {
  constructor(max?: number) {
    super(
      'too_many_files',
      max ? `You can hand in at most ${max} files` : 'You have too many files waiting; remove some',
    );
  }
}

export class SubmissionFilesNotReadyError extends BadRequestError {
  constructor() {
    super('files_not_ready', 'One of the files is not uploaded yet or is not yours');
  }
}

export class InvalidSubmissionError extends BadRequestError {
  constructor(message: string) {
    super('invalid_submission', message);
  }
}

export class SubmissionFileTooLargeError extends BadRequestError {
  constructor(maxMb: number) {
    super('file_too_large', `A file for this assignment can be at most ${maxMb} MB`);
  }
}

export class BlockedFileTypeError extends BadRequestError {
  constructor() {
    super(
      'file_type_blocked',
      'Programs and scripts cannot be handed in. Put them in a ZIP file if the assignment allows it',
    );
  }
}

export class InvalidGradeError extends BadRequestError {
  constructor(message: string, details?: ErrorDetail[]) {
    super('invalid_grade', message, details);
  }
}

export class SubmissionChangedError extends ConflictError {
  constructor() {
    super(
      'submission_changed',
      'The learner handed in a newer version while you were grading. Open it and grade again',
    );
  }
}

export class NotGradedError extends ConflictError {
  constructor() {
    super('not_graded', 'Grade this submission first');
  }
}

export class RubricNotUsableError extends NotFoundError {
  constructor() {
    super('rubric_not_found', 'This rubric does not exist in the course of the assignment');
  }
}

export class RubricArchivedError extends ConflictError {
  constructor() {
    super('rubric_archived', 'This rubric is archived: restore it before you attach it');
  }
}

export class GradingStartedError extends ConflictError {
  constructor() {
    super(
      'grading_started',
      'Submissions are already graded with this rubric. Release or regrade them before you attach another',
    );
  }
}

export class NameSortRefusedError extends BadRequestError {
  constructor() {
    super('sort_not_allowed', 'While grading is blind the queue cannot be ordered by name');
  }
}

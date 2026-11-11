import {
  AppError,
  BadRequestError,
  ConflictError,
  type ErrorDetail,
  NotFoundError,
} from '../../core/errors';

export class QuestionNotFoundError extends NotFoundError {
  constructor() {
    super('question_not_found', 'The question does not exist in this course');
  }
}

export class QuestionVersionNotFoundError extends NotFoundError {
  constructor() {
    super('question_version_not_found', 'This question has no such version');
  }
}

export class InvalidQuestionError extends BadRequestError {
  constructor(details: ErrorDetail[]) {
    super('invalid_question', 'The question is not valid', details);
  }
}

export class InvalidQuestionFileError extends BadRequestError {
  constructor() {
    super('invalid_file', 'An image is missing, not ready, not a PNG or JPEG, or not yours to use');
  }
}

/** Someone else saved a newer version while this one was being edited. */
export class QuestionChangedError extends ConflictError {
  constructor() {
    super('question_changed', 'The question was changed by someone else: reload it and edit again');
  }
}

export class QuestionImportNotFoundError extends NotFoundError {
  constructor() {
    super('import_not_found', 'This import does not exist');
  }
}

export class QuestionImportStateError extends ConflictError {
  constructor(status: string) {
    super('import_not_staged', `This import is already ${status}`);
  }
}

export class QuestionImportInvalidRowsError extends ConflictError {
  constructor(invalid: number) {
    super(
      'invalid_rows',
      `${invalid} row${invalid === 1 ? ' is' : 's are'} invalid: fix the file, or confirm with skipInvalid to import the valid rows only`,
    );
  }
}

export class QuestionImportFileError extends AppError {
  constructor(statusCode: 400 | 413, code: string, message: string) {
    super(statusCode, code, message);
  }
}

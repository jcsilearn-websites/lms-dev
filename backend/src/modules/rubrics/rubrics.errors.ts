import { BadRequestError, type ErrorDetail, NotFoundError } from '../../core/errors';

export class RubricNotFoundError extends NotFoundError {
  constructor() {
    super('rubric_not_found', 'This rubric does not exist in this course');
  }
}

export class InvalidRubricError extends BadRequestError {
  constructor(details: ErrorDetail[]) {
    super('invalid_rubric', 'The rubric is not valid', details);
  }
}

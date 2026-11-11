import { BadRequestError, ConflictError, type ErrorDetail, NotFoundError } from '../../core/errors';

export class AssessmentNotFoundError extends NotFoundError {
  constructor() {
    super('assessment_not_found', 'This assessment does not exist or is not open to you');
  }
}

export class AttemptNotFoundError extends NotFoundError {
  constructor() {
    super('attempt_not_found', 'This attempt does not exist');
  }
}

export class AnswerNotFoundError extends NotFoundError {
  constructor() {
    super('answer_not_found', 'There is no answer waiting for a grade at this place');
  }
}

export class AssessmentNotOpenError extends ConflictError {
  constructor() {
    super('assessment_not_open', 'This assessment is not open yet');
  }
}

export class AssessmentClosedError extends ConflictError {
  constructor() {
    super('assessment_closed', 'This assessment is closed');
  }
}

export class NoAttemptsLeftError extends ConflictError {
  constructor() {
    super('no_attempts_left', 'You have used all the attempts of this assessment');
  }
}

export class EmptyAssessmentError extends ConflictError {
  constructor() {
    super('assessment_empty', 'This assessment has no questions yet');
  }
}

export class PoolTooSmallError extends ConflictError {
  constructor() {
    super(
      'pool_too_small',
      'A random pool of this assessment has fewer questions than it asks for',
    );
  }
}

export class AttemptInProgressError extends ConflictError {
  constructor() {
    super('attempt_in_progress', 'Submit the attempt to see its result');
  }
}

export class InvalidSettingsError extends BadRequestError {
  constructor(message: string) {
    super('invalid_settings', message);
  }
}

export class InvalidSlotsError extends BadRequestError {
  constructor(details: ErrorDetail[]) {
    super('invalid_slots', 'The questions of the assessment are not valid', details);
  }
}

export class ScoreOutOfRangeError extends BadRequestError {
  constructor() {
    super('score_out_of_range', 'The score must be between 0 and the points of the question');
  }
}

export class RegradeOptionsChangedError extends ConflictError {
  constructor() {
    super(
      'options_changed',
      'The options of that version differ from what was shown: only a version with the same options can re-score; drop the question or give credit instead',
    );
  }
}

export class RegradeVersionError extends BadRequestError {
  constructor() {
    super('invalid_version', 'Choose a version of this question to score with');
  }
}

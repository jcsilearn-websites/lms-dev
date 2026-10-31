import { ConflictError, NotFoundError } from '../../core/errors';

export class ProgressItemNotFoundError extends NotFoundError {
  constructor() {
    super('item_not_found', 'This item does not exist or is not open to you');
  }
}

export class VideoChangedError extends ConflictError {
  constructor() {
    super('video_changed', 'The video of this item was replaced: reload the page');
  }
}

export class NotAVideoItemError extends ConflictError {
  constructor() {
    super('not_a_video_item', 'Watching progress is only recorded for video items');
  }
}

export class WrongCompletionRuleError extends ConflictError {
  constructor() {
    super('wrong_completion_rule', 'This item is not marked done by hand');
  }
}

export class LearnerNotFoundError extends NotFoundError {
  constructor() {
    super('learner_not_found', 'This learner does not take part in the offering');
  }
}

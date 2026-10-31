import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import { pgConstraint, pgErrorCode } from '../../db/pg-errors';

export class ModuleNotFoundError extends NotFoundError {
  constructor() {
    super('module_not_found', 'The module does not exist in this offering');
  }
}

export class ItemNotFoundError extends NotFoundError {
  constructor() {
    super('item_not_found', 'The item does not exist in this offering');
  }
}

export class SiblingNotFoundError extends NotFoundError {
  constructor() {
    super('sibling_not_found', 'The entry to place this after does not exist here');
  }
}

export class InvalidRichTextError extends BadRequestError {
  constructor(details: { path: string; message: string }[]) {
    super('invalid_rich_text', 'The text contains something that is not allowed', details);
  }
}

export class InvalidItemError extends BadRequestError {
  constructor(message = 'A text item has a body, a file item a file, a link item a web address') {
    super('invalid_item', message);
  }
}

export class InvalidLinkError extends BadRequestError {
  constructor() {
    super('invalid_link', 'A link must be an http or https address');
  }
}

export class InvalidFileError extends BadRequestError {
  constructor() {
    super(
      'invalid_file',
      'The file does not exist, is not uploaded yet, or is not yours to attach',
    );
  }
}

export class InvalidVideoError extends BadRequestError {
  constructor() {
    super('invalid_video', 'Choose a video of this offering that has finished processing');
  }
}

export class NothingToChangeError extends BadRequestError {
  constructor() {
    super('nothing_to_update', 'Send at least one field to change');
  }
}

export class CopyNotPossibleError extends BadRequestError {
  constructor(message: string) {
    super('copy_not_possible', message);
  }
}

export class CopyInProgressError extends ConflictError {
  constructor() {
    super('copy_in_progress', 'A copy into this offering is still running');
  }
}

/** Two requests picked the same position at once: the caller retries with a fresh pick. */
export function isPositionConflict(err: unknown): boolean {
  return (
    pgErrorCode(err) === '23505' &&
    ['content_modules_position_key', 'content_items_position_key'].includes(pgConstraint(err) ?? '')
  );
}

/** Translates constraint errors of migration 0018 into API errors; null = not one of ours. */
export function mapContentDbError(err: unknown): Error | null {
  const code = pgErrorCode(err);
  const constraint = pgConstraint(err) ?? '';
  if (code === '23514' && constraint === 'content_items_kind_ck') return new InvalidItemError();
  if (code === '23514' && constraint === 'content_items_completion_ck')
    return new InvalidItemError();
  if (code === '23514' && constraint.startsWith('content_items_url')) return new InvalidLinkError();
  if (code === '23503') return new ModuleNotFoundError();
  return null;
}

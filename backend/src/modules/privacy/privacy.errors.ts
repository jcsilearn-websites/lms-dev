import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from '../../core/errors';

/** Not an active member of this college (or on the admin host): nothing to export. */
export class NotAnActiveMemberError extends ForbiddenError {
  constructor() {
    super('not_an_active_member', 'Only an active member of a college can export their data there');
  }
}

/** At most 3 requests a day. */
export class ExportLimitError extends TooManyRequestsError {
  constructor() {
    super('export_limit', 'You can request your data at most 3 times a day. Try again later.');
  }
}

/** Somebody else's export, another college's, an unknown id: all the same. */
export class ExportNotFoundError extends NotFoundError {
  constructor() {
    super('export_not_found', 'This export does not exist');
  }
}

export class ExportNotReadyError extends ConflictError {
  constructor() {
    super('export_not_ready', 'This export is still being prepared');
  }
}

export class ExportExpiredError extends ConflictError {
  constructor() {
    super('export_expired', 'This export has expired and was deleted. Request a new one.');
  }
}

import { AppError, NotFoundError } from '../../core/errors';

export class VideoItemNotFoundError extends NotFoundError {
  constructor() {
    super('video_item_not_found', 'This video does not exist in this offering');
  }
}

export class InvalidTimeZoneError extends AppError {
  constructor() {
    super(
      400,
      'invalid_time_zone',
      'This is not a time zone name the database knows (e.g. Asia/Kolkata)',
    );
  }
}

export class ReportNotFoundError extends NotFoundError {
  constructor() {
    super('report_not_found', 'There is no such report');
  }
}

export class ReportDisabledError extends NotFoundError {
  constructor() {
    super('report_disabled', 'This college has switched this report off');
  }
}

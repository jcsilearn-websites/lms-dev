import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../core/errors';

export class VideoNotFoundError extends NotFoundError {
  constructor() {
    super('video_not_found', 'The video does not exist');
  }
}

export class VideoTypeNotAllowedError extends BadRequestError {
  constructor() {
    super('video_type_not_allowed', 'Upload an MP4, MOV, MKV or WebM video');
  }
}

export class VideoTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(
      413,
      'video_too_large',
      `A video can be at most ${Math.round((maxBytes / (1024 * 1024 * 1024)) * 10) / 10} GB`,
    );
  }
}

export class VideoContentMismatchError extends BadRequestError {
  constructor() {
    super(
      'video_content_mismatch',
      'The content of the file does not look like a video of that type',
    );
  }
}

/** The client asks `GET .../upload` for the offset to resume from. */
export class UploadOffsetError extends ConflictError {
  constructor(readonly currentOffset: number) {
    super('upload_offset_mismatch', 'The chunk does not start where the upload stands');
  }
}

export class UploadBusyError extends ConflictError {
  constructor() {
    super('upload_busy', 'Another chunk of this upload is being received');
  }
}

export class UploadNotOpenError extends ConflictError {
  constructor() {
    super('upload_not_open', 'This video is no longer accepting data');
  }
}

export class UploadIncompleteError extends ConflictError {
  constructor(readonly currentOffset: number) {
    super('upload_incomplete', 'Not all of the file has been uploaded yet');
  }
}

export class VideoNotReadyError extends ConflictError {
  constructor() {
    super('video_not_ready', 'This video is not ready yet');
  }
}

export class VideoInUseError extends ConflictError {
  constructor() {
    super('video_in_use', 'The video is used by a lesson; remove it from the lesson first');
  }
}

export class CaptionInvalidError extends BadRequestError {
  constructor(message: string) {
    super('caption_invalid', message);
  }
}

export class TooManyCaptionsError extends ConflictError {
  constructor(max: number) {
    super('too_many_captions', `A video can have at most ${max} caption languages`);
  }
}

export class CaptionNotFoundError extends NotFoundError {
  constructor() {
    super('caption_not_found', 'The caption does not exist');
  }
}

export class PlaybackLinkInvalidError extends AppError {
  constructor() {
    super(403, 'invalid_link', 'This link is not valid or has expired');
  }
}

export class VideoUnavailable extends ServiceUnavailableError {
  constructor() {
    super('video_unavailable', 'Video is not available');
  }
}

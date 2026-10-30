import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors';

export class FileNotFoundError extends NotFoundError {
  constructor() {
    super('file_not_found', 'The file does not exist');
  }
}

export class FileTypeNotAllowedError extends BadRequestError {
  constructor() {
    super(
      'file_type_not_allowed',
      'This type of file cannot be uploaded (allowed: PDF, images, Office documents, text, CSV, ZIP, MP4, MP3)',
    );
  }
}

export class FileTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(
      413,
      'file_too_large',
      `A file can be at most ${Math.floor(maxBytes / (1024 * 1024))} MB`,
    );
  }
}

export class FileContentMismatchError extends BadRequestError {
  constructor() {
    super('file_content_mismatch', 'The content of the file does not match its type');
  }
}

export class FileSizeMismatchError extends BadRequestError {
  constructor() {
    super('size_mismatch', 'The uploaded file is not the size that was announced');
  }
}

export class UploadMissingError extends ConflictError {
  constructor() {
    super('upload_missing', 'No file has been uploaded for this request (or the link expired)');
  }
}

export class StorageLinkInvalidError extends AppError {
  constructor() {
    super(403, 'invalid_link', 'This link is not valid or has expired');
  }
}

export class StorageUnavailable extends AppError {
  constructor() {
    super(503, 'storage_unavailable', 'File storage is not available');
  }
}

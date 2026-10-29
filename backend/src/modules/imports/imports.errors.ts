import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import type { HeaderProblem } from './imports.csv';

export class ImportNotFoundError extends NotFoundError {
  constructor() {
    super('import_not_found', 'Import not found');
  }
}

/** The upload is refused as a whole; nothing was staged. */
export class InvalidImportFileError extends BadRequestError {
  constructor(code: string, message: string, details?: { path: string; message: string }[]) {
    super(code, message, details);
  }
}

export function headerProblemError(p: HeaderProblem): InvalidImportFileError {
  const list = p.columns.join(', ');
  switch (p.code) {
    case 'empty_file':
      return new InvalidImportFileError('empty_file', 'The file is empty');
    case 'missing_columns':
      return new InvalidImportFileError('missing_columns', `Missing columns: ${list}`);
    case 'unknown_columns':
      return new InvalidImportFileError('unknown_columns', `Unknown columns: ${list}`);
    case 'duplicate_columns':
      return new InvalidImportFileError('duplicate_columns', `Columns given twice: ${list}`);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(code: 'file_too_large' | 'too_many_rows', message: string) {
    super(413, code, message);
  }
}

export class UnsupportedFileTypeError extends AppError {
  constructor() {
    super(415, 'unsupported_file_type', 'Upload a .csv file');
  }
}

export class NoFileError extends BadRequestError {
  constructor() {
    super('no_file', 'Send the CSV as a multipart file');
  }
}

/** The staged rows were deleted after the retention period. */
export class RowsPurgedError extends AppError {
  constructor() {
    super(
      410,
      'rows_purged',
      'The staged rows of this import were deleted (retention period over)',
    );
  }
}

export class ImportInProgressError extends ConflictError {
  constructor() {
    super(
      'import_in_progress',
      'Another import is running for this college: wait for it to finish',
    );
  }
}

export class ImportNotConfirmableError extends ConflictError {
  constructor(status: string) {
    super(
      'import_not_confirmable',
      `An import in status "${status}" cannot be confirmed or cancelled`,
    );
  }
}

export class HasInvalidRowsError extends ConflictError {
  constructor(invalid: number) {
    super(
      'has_invalid_rows',
      `${invalid} row(s) are invalid: fix the file, or confirm with skipInvalid=true to import only the valid rows`,
    );
  }
}

export class NothingToImportError extends ConflictError {
  constructor() {
    super('nothing_to_import', 'There are no valid rows to import');
  }
}

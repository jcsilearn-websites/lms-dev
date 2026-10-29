export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Throw (a subclass of) this for expected failures. `message` is shown to clients: keep it safe.
 * Module-specific errors live in `<module>.errors.ts` and carry a stable `code`.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string, details?: ErrorDetail[]) {
    super(400, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(code: string, message: string) {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(503, code, message, undefined, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code = 'unauthenticated', message = 'Authentication required') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'forbidden', message = 'You do not have access to this resource') {
    super(403, code, message);
  }
}

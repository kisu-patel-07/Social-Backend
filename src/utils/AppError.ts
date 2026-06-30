import { HttpStatus } from '../constants/httpStatus';

/**
 * Operational error type thrown intentionally by the application.
 * The global error handler distinguishes these (safe to surface to clients)
 * from unexpected programming errors (which are masked in production).
 */
export class AppError extends Error {
  public readonly statusCode: HttpStatus;
  public readonly isOperational: boolean;
  public readonly errorCode?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    options: { errorCode?: string; details?: unknown; isOperational?: boolean } = {}
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = options.isOperational ?? true;
    this.errorCode = options.errorCode;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 — invalid input or malformed request. */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, { errorCode: 'BAD_REQUEST', details });
  }
}

/** 401 — authentication required or failed. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, HttpStatus.UNAUTHORIZED, { errorCode: 'UNAUTHORIZED' });
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, HttpStatus.FORBIDDEN, { errorCode: 'FORBIDDEN' });
  }
}

/** 404 — resource not found. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, HttpStatus.NOT_FOUND, { errorCode: 'NOT_FOUND' });
  }
}

/** 409 — conflict with current state (e.g. duplicate). */
export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, HttpStatus.CONFLICT, { errorCode: 'CONFLICT', details });
  }
}

/** 422 — semantically invalid input (validation failure). */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY, { errorCode: 'VALIDATION_ERROR', details });
  }
}

/** 502 — an upstream/third-party (e.g. Meta Graph API) call failed. */
export class ExternalServiceError extends AppError {
  constructor(message = 'External service error', details?: unknown) {
    super(message, HttpStatus.BAD_GATEWAY, { errorCode: 'EXTERNAL_SERVICE_ERROR', details });
  }
}

import { ErrorRequestHandler } from 'express';
import { MongoServerError } from 'mongodb';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { isProduction } from '../config/env';
import { logger } from '../config/logger';
import { HttpStatus } from '../constants/httpStatus';
import { AppError } from '../utils/AppError';
import { ApiErrorBody } from '../types/common.types';

/**
 * Global error handler. Normalizes every thrown error into the standard API
 * error envelope and decides what is safe to expose to the client.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let message = 'Internal server error';
  let errorCode: string | undefined;
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    errorCode = err.errorCode;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
    message = 'Validation failed';
    errorCode = 'VALIDATION_ERROR';
    details = err.flatten().fieldErrors;
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
    message = 'Validation failed';
    errorCode = 'VALIDATION_ERROR';
    details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = HttpStatus.BAD_REQUEST;
    message = `Invalid value for "${err.path}"`;
    errorCode = 'CAST_ERROR';
  } else if ((err as MongoServerError)?.code === 11000) {
    statusCode = HttpStatus.CONFLICT;
    const keys = Object.keys((err as MongoServerError).keyValue ?? {});
    message = `Duplicate value for: ${keys.join(', ')}`;
    errorCode = 'DUPLICATE_KEY';
    details = (err as MongoServerError).keyValue;
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  // Log server errors with stack; client errors at warn level.
  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    logger.error(`${req.method} ${req.originalUrl} -> ${statusCode}`, {
      message: (err as Error)?.message,
      stack: (err as Error)?.stack,
    });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode}: ${message}`);
  }

  const body: ApiErrorBody = {
    success: false,
    message: isProduction && statusCode >= 500 ? 'Internal server error' : message,
    ...(errorCode ? { errorCode } : {}),
    ...(details ? { errors: details } : {}),
    ...(!isProduction && err instanceof Error ? { stack: err.stack } : {}),
  };

  res.status(statusCode).json(body);
};

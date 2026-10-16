import { AppError } from '../lib/errors.js';
import { isProduction } from '../config.js';

/**
 * One place decides what the client is told.
 *
 * REQ-SEC-006: an unexpected error returns a generic message and a
 * request id. Stack traces, SQL fragments and constraint names are
 * reconnaissance material, so they go to the server log and nowhere
 * else. The request id lets a support conversation connect a user's
 * screenshot to a specific log line without exposing anything.
 */
export function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        requestId: req.id
      }
    });
  }

  // Postgres constraint violations mapped to intelligible client errors.
  if (error.code === '23505') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'That record already exists.', requestId: req.id }
    });
  }
  if (error.code === '23503') {
    return res.status(400).json({
      error: { code: 'BAD_REFERENCE', message: 'A referenced record does not exist.', requestId: req.id }
    });
  }
  if (error.code === '22P02') {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: req.id }
    });
  }

  console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, error);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side.',
      requestId: req.id,
      ...(isProduction ? {} : { debug: error.message })
    }
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Endpoint not found.', requestId: req.id }
  });
}

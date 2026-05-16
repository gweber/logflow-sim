import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isDomainError } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { ErrorResponseDTO } from './dto.js';

/**
 * Wrap an async route handler so thrown errors flow into the Express
 * error pipeline instead of crashing the request as unhandled promise
 * rejections. Without this every async route would need a try/catch.
 *
 *   router.get('/x', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler<R extends RequestHandler>(handler: R): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Centralized error -> HTTP response mapping. Domain errors carry their
 * own `httpStatus` and `code`; everything else falls into a 500 with the
 * generic `INTERNAL_ERROR` code. The full error (with stack) is logged
 * server-side regardless.
 */
export function errorHandler(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => void {
  return (err, req, res, _next) => {
    const requestLog = log.child({ method: req.method, path: req.path });
    if (isDomainError(err)) {
      requestLog.warn(err.message, { code: err.code, context: err.context });
      const body: ErrorResponseDTO = {
        error: { code: err.code, message: err.message, context: err.context }
      };
      res.status(err.httpStatus).json(body);
      return;
    }
    const e = err as Error;
    requestLog.error('Unhandled error', { error: e.message, stack: e.stack });
    const body: ErrorResponseDTO = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
    };
    res.status(500).json(body);
  };
}

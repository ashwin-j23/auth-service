import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// Express recognizes this as an error handler purely by its 4-argument
// signature — keep all four params even though `_next` is unused.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { message: err.message } });
  }

  // Unexpected error — log full detail server-side, never leak internals
  // (stack traces, DB errors, etc.) to the client.
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: { message: 'Internal server error' } });
}

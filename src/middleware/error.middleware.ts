import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * body-parser (express.json()) and other middleware built on the
 * `http-errors` convention throw plain Error objects carrying
 * `.statusCode`/`.status` and `.expose`, not our AppError class — e.g. a
 * PayloadTooLargeError when JSON_BODY_LIMIT is exceeded, or a SyntaxError
 * for malformed JSON. `expose: true` is that convention's own signal that
 * the error message is safe to show a client (as opposed to a 5xx where
 * it isn't) — this checks for exactly that signal rather than hardcoding
 * a list of specific error classes/messages to special-case.
 */
function asExposedHttpError(err: unknown): { statusCode: number; message: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const candidate = err as Error & { statusCode?: unknown; status?: unknown; expose?: unknown };
  if (candidate.expose !== true) return undefined;
  const statusCode =
    typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return undefined;
  return { statusCode, message: candidate.message };
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

  const exposedHttpError = asExposedHttpError(err);
  if (exposedHttpError) {
    return res.status(exposedHttpError.statusCode).json({
      error: { message: exposedHttpError.message },
    });
  }

  // Unexpected error — log full detail server-side, never leak internals
  // (stack traces, DB errors, etc.) to the client.
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: { message: 'Internal server error' } });
}

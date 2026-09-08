import type { NextFunction, Request, Response } from 'express';
import type { AnyZodObject } from 'zod';
import { AppError } from '../utils/AppError';

/** Validates req.{body,query,params} against a zod schema, 400s on failure. */
export function validate(schema: AnyZodObject) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!result.success) {
      const message = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return next(new AppError(400, message));
    }
    // Replace with the parsed/coerced data (e.g. trimmed strings) for every
    // part of the request the schema actually covers. None of this app's
    // schemas currently validate `query`/`params` (they're all
    // `z.object({ body: ... })`), so those two are no-ops today — but this
    // function accepts and parses all three, and only writing `body` back
    // silently drops query/param transforms the moment a schema adds one.
    const data = result.data as { body?: unknown; query?: unknown; params?: unknown };
    req.body = data.body ?? req.body;
    if (data.query !== undefined) {
      req.query = data.query as Request['query'];
    }
    if (data.params !== undefined) {
      req.params = data.params as Request['params'];
    }
    next();
  };
}

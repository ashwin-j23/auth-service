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
    // Replace with the parsed/coerced data (e.g. trimmed strings).
    req.body = result.data.body ?? req.body;
    next();
  };
}

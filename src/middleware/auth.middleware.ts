import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string };
}

/** Requires a valid `Authorization: Bearer <accessToken>` header. */
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing bearer token'));
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired access token'));
  }
}

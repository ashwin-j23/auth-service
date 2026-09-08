import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    // @types/jsonwebtoken types `expiresIn` as a branded string (via `ms`),
    // not a plain `string` — env.JWT_ACCESS_TTL is validated at startup
    // (src/config/env.ts) to be a value jwt.sign accepts (e.g. "15m"), so
    // this cast is safe.
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Throws jwt.JsonWebTokenError / jwt.TokenExpiredError on an invalid or
 * expired token — callers should catch and translate to an AppError(401).
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === 'string' || !decoded.sub || !decoded.email) {
    throw new jwt.JsonWebTokenError('Malformed access token payload');
  }
  return { sub: decoded.sub, email: decoded.email as string };
}

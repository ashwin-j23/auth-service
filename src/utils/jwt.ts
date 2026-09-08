import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  jti: string; // unique ID for this specific token — see signAccessToken
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    // @types/jsonwebtoken types `expiresIn` as a branded string (via `ms`),
    // not a plain `string` — env.JWT_ACCESS_TTL is validated at startup
    // (src/config/env.ts) to be a value jwt.sign accepts (e.g. "15m"), so
    // this cast is safe.
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    // A unique ID for this specific token (not the user — a fresh one every
    // signup/login/refresh). Unused by this app's own logic today: nothing
    // currently checks it, and access tokens are still only ever invalidated
    // by expiring (15 minutes by default) — there's no revocation list. This
    // is deliberately laid in as the minimum groundwork such a list would
    // need later (a per-token identifier to blocklist), without building the
    // list itself now: that needs a shared store (e.g. Redis) checked on
    // every authenticated request, which is a real infrastructure/latency
    // tradeoff against the current fully-stateless design, not a small
    // addition — reasonable to defer until immediate token revocation is an
    // actual requirement, not merely a theoretical nice-to-have.
    jwtid: crypto.randomUUID(),
  });
}

/**
 * Throws jwt.JsonWebTokenError / jwt.TokenExpiredError on an invalid or
 * expired token — callers should catch and translate to an AppError(401).
 * Requires (not just tolerates) a matching `iss`/`aud` — a token that's
 * otherwise validly signed but issued for a different audience is rejected
 * exactly like a bad signature, not silently accepted.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if (typeof decoded === 'string' || !decoded.sub || !decoded.email || !decoded.jti) {
    throw new jwt.JsonWebTokenError('Malformed access token payload');
  }
  return { sub: decoded.sub, email: decoded.email as string, jti: decoded.jti };
}

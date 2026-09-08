import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import * as authService from '../services/auth.service';
import * as googleService from '../services/google.service';
import * as tokenService from '../services/token.service';
import { createHandoff, consumeHandoff } from '../services/oauthHandoff.service';
import { AppError } from '../utils/AppError';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { prisma } from '../lib/prisma';
import { toPublicUser } from '../utils/publicUser';

const OAUTH_STATE_COOKIE = 'oauth_state';
// Shared between googleRedirect (which sets this cookie) and googleCallback
// (which clears it) so the two can never drift out of sync. That matters
// because a cookie is not cleared just by calling res.clearCookie(name) with
// no options — Express (and the underlying Set-Cookie mechanics) needs the
// clearing call's attributes to match the ones the cookie was actually set
// with, or the browser may simply keep the original cookie around instead of
// overwriting it. An earlier version set this cookie with
// { httpOnly, secure, sameSite, signed, maxAge } but cleared it with no
// options at all, which could leave the cookie sitting in the browser past
// this callback, available to be reused in a way it was never meant to be.
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  signed: true,
};

/**
 * Checks the `code`/`state` query params against the signed state cookie.
 * Pure — no response mutation here on purpose (see googleCallback): a CSRF
 * state token should be validated *before* it's consumed/cleared, the same
 * "burn after a single successful use" pattern as a refresh token (§9) or a
 * handoff code (oauthHandoff.service.ts) — not cleared as an incidental
 * first step regardless of whether this request turns out to be legitimate.
 * Throws AppError(400) for anything invalid; returns the validated `code`.
 */
function validateOAuthCallback(query: Request['query'], cookieState: unknown): string {
  const { code, state } = query;
  if (typeof code !== 'string') {
    throw new AppError(400, 'Missing authorization code');
  }
  if (!state || !cookieState || state !== cookieState) {
    // Mismatched/missing state means this callback wasn't initiated by us
    // — classic OAuth CSRF, reject outright rather than exchange the code.
    throw new AppError(400, 'Invalid or missing OAuth state');
  }
  return code;
}

export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.signup(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.login(req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const tokens = await tokenService.rotateRefreshToken(req.body.refreshToken);
    res.status(200).json({ tokens });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await tokenService.revokeRefreshToken(req.body.refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) {
      // Unreachable in practice (requireAuth runs first) — satisfies the
      // type checker and guards against the route being wired up wrong.
      throw new AppError(401, 'Not authenticated');
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }
    if (!user.isActive) {
      // The access token itself doesn't know a user was disabled after it
      // was issued — it's a self-contained, stateless JWT (see jwt.ts) that
      // stays "valid" purely by having the right signature and not having
      // expired yet. This is the check that catches that gap: `me` already
      // does a database read on every call, so it's a natural, low-cost
      // place to also confirm the account is still meant to work. A 403
      // (not the generic-message 401 pattern login uses) is fine here
      // specifically because there's no enumeration concern to protect
      // against — the caller has already proven their identity by holding
      // a valid token for this exact account.
      throw new AppError(403, 'This account has been disabled');
    }
    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** GET /auth/google — redirects the browser to Google's consent screen. */
export function googleRedirect(_req: Request, res: Response) {
  const state = crypto.randomBytes(24).toString('hex');

  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...OAUTH_STATE_COOKIE_OPTIONS,
    maxAge: 5 * 60 * 1000, // 5 minutes — just long enough to complete the consent screen
  });

  res.redirect(googleService.getGoogleAuthUrl(state));
}

/** GET /auth/google/callback — Google redirects here with `code` + `state`. */
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const cookieState = req.signedCookies?.[OAUTH_STATE_COOKIE];
    // Validate FIRST, clear second — not the other way around. Clearing is a
    // response mutation; performing it before the request has even been
    // checked means an invalid/forged callback still gets to consume (and
    // therefore invalidate) the real, legitimate state cookie for whatever
    // OAuth attempt is actually still in flight in this browser. Wrapping
    // just the validation in its own try/finally keeps the clear tied to
    // "we attempted to consume this state" without smearing it earlier than
    // that across the function.
    let code: string;
    try {
      code = validateOAuthCallback(req.query, cookieState);
    } finally {
      res.clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_OPTIONS);
    }

    const { user, tokens } = await googleService.loginWithGoogleCode(code);

    // Tokens are deliberately NOT put in this redirect URL: a URL can end up
    // in browser history, the frontend's own server access logs, or a
    // Referer header sent to any third-party resource the landing page
    // loads. Instead, hand the browser a short-lived, single-use handoff
    // code and let the frontend immediately exchange it for the real tokens
    // via POST /auth/google/exchange (see oauthHandoff.service.ts).
    const handoffCode = createHandoff(user, tokens);

    const redirectUrl = new URL(env.OAUTH_SUCCESS_REDIRECT_URL);
    redirectUrl.searchParams.set('code', handoffCode);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/google/exchange — the frontend calls this immediately after
 * being redirected back from googleCallback, trading the short-lived
 * handoff `code` in the URL for the actual user + tokens.
 */
export async function googleExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const result = consumeHandoff(req.body.code);
    if (!result) {
      throw new AppError(400, 'Invalid, expired, or already-used exchange code');
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

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
 * Everything googleRedirect generates for one in-flight Google login attempt,
 * carried together as a single signed cookie value (JSON-encoded) rather than
 * three separate cookies:
 *  - `state` — the OAuth CSRF token (unchanged from before).
 *  - `nonce` — bound into the auth request and checked against the `nonce`
 *    claim Google's ID token echoes back (google.service.ts), so a validly
 *    signed ID token from some other flow can't be replayed into this one.
 *  - `codeVerifier` — the PKCE (RFC 7636) secret; its SHA-256 is sent to
 *    Google up front as `code_challenge`, and the raw value is sent back at
 *    token-exchange time so Google can confirm the two match, binding the
 *    authorization `code` to whoever holds this cookie.
 * All three are single-use and only ever needed for the few minutes between
 * this redirect and the callback, so one short-lived signed cookie is enough
 * — no server-side session store required.
 */
interface OAuthCookiePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
}

function parseOAuthCookie(raw: unknown): OAuthCookiePayload | undefined {
  if (typeof raw !== 'string') return undefined; // absent, or signature verification failed
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).state === 'string' &&
      typeof (parsed as Record<string, unknown>).nonce === 'string' &&
      typeof (parsed as Record<string, unknown>).codeVerifier === 'string'
    ) {
      return parsed as OAuthCookiePayload;
    }
  } catch {
    // Malformed JSON — treated the same as a missing/invalid cookie below.
  }
  return undefined;
}

/**
 * Generates a fresh PKCE (RFC 7636) verifier/challenge pair for one Google
 * login attempt. `codeVerifier` is 32 random bytes, base64url-encoded (43
 * characters, no padding) — comfortably within RFC 7636's required 43-128
 * character range. `codeChallenge` is the base64url SHA-256 digest of that
 * verifier, sent to Google up front; Google recomputes it from the verifier
 * we send back at token-exchange time and rejects the exchange if they don't
 * match.
 */
function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Thrown specifically for the "user clicked Cancel on Google's consent
 * screen" case, so googleCallback can tell it apart from every other
 * failure and redirect the browser back to the frontend instead of dead-
 * ending it on a raw JSON error — see the comment at its one call site.
 */
class OAuthConsentDeniedError extends Error {}

/**
 * Checks the `code`/`state` query params against the signed state cookie.
 * Pure — no response mutation here on purpose (see googleCallback): a CSRF
 * state token should be validated *before* it's consumed/cleared, the same
 * "burn after a single successful use" pattern as a refresh token (§9) or a
 * handoff code (oauthHandoff.service.ts) — not cleared as an incidental
 * first step regardless of whether this request turns out to be legitimate.
 * Throws OAuthConsentDeniedError if the user denied consent, AppError(400)
 * for anything else invalid; otherwise returns the validated `code` plus the
 * `nonce`/`codeVerifier` this same flow generated, for the caller to pass on
 * to the token exchange.
 */
function validateOAuthCallback(
  query: Request['query'],
  cookiePayload: OAuthCookiePayload | undefined,
): { code: string; nonce: string; codeVerifier: string } {
  const { code, state, error } = query;
  if (error === 'access_denied') {
    // Google redirects here with `?error=access_denied&state=...` (no
    // `code` at all) specifically when the user clicks "Cancel" on the
    // consent screen — an easily-hit, completely normal part of this flow
    // (anyone who's ever demoed it has hit Cancel by accident at least
    // once), not a failure worth a raw API error page. Checked before the
    // generic "missing code" case below specifically so this doesn't fall
    // through into it.
    //
    // Deliberately narrower than "any truthy `error` param": OAuth defines
    // other error codes (`server_error`, `temporarily_unavailable`,
    // `invalid_request`, ...) that are real provider-side failures, not a
    // user declining consent — those fall through to the generic
    // "missing authorization code" handling below instead of being
    // mislabeled as a cancellation.
    throw new OAuthConsentDeniedError(error);
  }
  if (typeof code !== 'string') {
    throw new AppError(400, 'Missing authorization code');
  }
  if (!state || !cookiePayload || state !== cookiePayload.state) {
    // Mismatched/missing state means this callback wasn't initiated by us
    // — classic OAuth CSRF, reject outright rather than exchange the code.
    throw new AppError(400, 'Invalid or missing OAuth state');
  }
  return { code, nonce: cookiePayload.nonce, codeVerifier: cookiePayload.codeVerifier };
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
  const nonce = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = generatePkcePair();

  const cookiePayload: OAuthCookiePayload = { state, nonce, codeVerifier };
  res.cookie(OAUTH_STATE_COOKIE, JSON.stringify(cookiePayload), {
    ...OAUTH_STATE_COOKIE_OPTIONS,
    maxAge: 5 * 60 * 1000, // 5 minutes — just long enough to complete the consent screen
  });

  res.redirect(googleService.getGoogleAuthUrl(state, nonce, codeChallenge));
}

/** GET /auth/google/callback — Google redirects here with `code` + `state`. */
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const cookiePayload = parseOAuthCookie(req.signedCookies?.[OAUTH_STATE_COOKIE]);
    // Validate FIRST, clear second — not the other way around. Clearing is a
    // response mutation; performing it before the request has even been
    // checked means an invalid/forged callback still gets to consume (and
    // therefore invalidate) the real, legitimate state cookie for whatever
    // OAuth attempt is actually still in flight in this browser.
    //
    // NOT a try/finally: `finally` runs even after a `return` inside the
    // `catch` below, which — for the consent-denied branch — is AFTER
    // `res.redirect()` has already sent the response. Calling
    // `res.clearCookie()` (which sets a header) past that point throws
    // ERR_HTTP_HEADERS_SENT instead of clearing anything. Clearing the
    // cookie explicitly on every path below, always before that path's own
    // response goes out, avoids that.
    let code: string, nonce: string, codeVerifier: string;
    try {
      ({ code, nonce, codeVerifier } = validateOAuthCallback(req.query, cookiePayload));
    } catch (err) {
      res.clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_OPTIONS);
      if (err instanceof OAuthConsentDeniedError) {
        // Every OTHER error path in this controller either redirects the
        // browser somewhere sensible or returns a clean JSON error — this
        // is the one case that used to just dead-end on a raw 400 mid-flow.
        // Send the browser back to the frontend with an indicator in the
        // query string instead, the same "redirect back, don't just fail
        // the API call" shape as a successful callback (see the handoff
        // redirect below), so the frontend can show its own "you cancelled
        // sign-in" state rather than a bare API error page.
        const redirectUrl = new URL(env.OAUTH_SUCCESS_REDIRECT_URL);
        redirectUrl.searchParams.set('error', 'google_consent_denied');
        res.redirect(redirectUrl.toString());
        return;
      }
      throw err;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_OPTIONS);

    const { user, tokens } = await googleService.loginWithGoogleCode(code, codeVerifier, nonce);

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

// Every response below is deliberately the exact same shape whether or not
// anything actually happened server-side (an account existed, an email was
// already verified, a token was genuinely sent) — see the enumeration-
// resistance comments on authService.requestEmailVerification/
// requestPasswordReset. Only the *confirm* endpoints, which require
// possessing a specific high-entropy token rather than just guessing an
// email address, can afford to be specific about failure.

/** POST /auth/email/verify — sends (or resends) an email-verification link. */
export async function requestEmailVerification(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.requestEmailVerification(req.body.email);
    res.status(200).json({
      message: 'If that email exists and is not yet verified, a verification link has been sent.',
    });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/email/verify/confirm — consumes the token from that link. */
export async function confirmEmailVerification(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.confirmEmailVerification(req.body.token);
    res.status(200).json({ message: 'Email verified.' });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/password/reset — sends a password-reset link. */
export async function requestPasswordReset(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.requestPasswordReset(req.body.email);
    res
      .status(200)
      .json({ message: 'If an account exists for that email, a password reset link has been sent.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/password/reset/confirm — consumes the token from that link and
 * sets a new password. Every existing session on the account is revoked as
 * part of this (see authService.confirmPasswordReset), so the response
 * deliberately doesn't hand back a fresh token pair — the client is
 * expected to log in again with the new password.
 */
export async function confirmPasswordReset(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.confirmPasswordReset(req.body.token, req.body.password);
    res.status(200).json({ message: 'Password has been reset. Please log in again.' });
  } catch (err) {
    next(err);
  }
}

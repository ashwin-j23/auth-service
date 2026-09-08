import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import * as authService from '../services/auth.service';
import * as googleService from '../services/google.service';
import * as tokenService from '../services/token.service';
import { AppError } from '../utils/AppError';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { prisma } from '../lib/prisma';
import { toPublicUser } from '../utils/publicUser';

const OAUTH_STATE_COOKIE = 'oauth_state';

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
    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** GET /auth/google — redirects the browser to Google's consent screen. */
export function googleRedirect(_req: Request, res: Response) {
  const state = crypto.randomBytes(24).toString('hex');

  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: true,
    maxAge: 5 * 60 * 1000, // 5 minutes — just long enough to complete the consent screen
  });

  res.redirect(googleService.getGoogleAuthUrl(state));
}

/** GET /auth/google/callback — Google redirects here with `code` + `state`. */
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, state } = req.query;
    const cookieState = req.signedCookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE);

    if (typeof code !== 'string') {
      throw new AppError(400, 'Missing authorization code');
    }
    if (!state || !cookieState || state !== cookieState) {
      // Mismatched/missing state means this callback wasn't initiated by us
      // — classic OAuth CSRF, reject outright rather than exchange the code.
      throw new AppError(400, 'Invalid or missing OAuth state');
    }

    const { tokens } = await googleService.loginWithGoogleCode(code);

    const redirectUrl = new URL(env.OAUTH_SUCCESS_REDIRECT_URL);
    redirectUrl.searchParams.set('accessToken', tokens.accessToken);
    redirectUrl.searchParams.set('refreshToken', tokens.refreshToken);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    next(err);
  }
}

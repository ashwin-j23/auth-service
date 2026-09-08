import { OAuth2Client } from 'google-auth-library';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { normalizeEmail } from '../utils/email';
import { issueTokenPair, type TokenPair } from './token.service';
import { toPublicUser, type PublicUser } from '../utils/publicUser';

function buildOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/** URL to send the browser to in order to start the Google consent flow. */
export function getGoogleAuthUrl(state: string): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent',
    state,
  });
}

interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/** Exchanges the authorization `code` from Google's callback for the user's verified profile. */
export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const client = buildOAuthClient();

  let idToken: string | undefined | null;
  try {
    const { tokens } = await client.getToken(code);
    idToken = tokens.id_token;
  } catch {
    throw new AppError(400, 'Failed to exchange Google authorization code');
  }

  if (!idToken) {
    throw new AppError(400, 'Google did not return an ID token');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new AppError(400, 'Google ID token is missing required claims');
  }

  return {
    googleId: payload.sub,
    // Reuses the exact same normalization signup/login use (src/utils/email.ts)
    // rather than reimplementing trim+lowercase here — two independent
    // "canonical email" implementations drifting apart is exactly what would
    // make the email-based account-linking lookup below miss a real match.
    email: normalizeEmail(payload.email),
    emailVerified: payload.email_verified ?? false,
    name: payload.name ?? null,
  };
}

/**
 * Finds the local user matching a Google profile, creating or linking one as
 * needed:
 *  - already linked to this Google account -> return it
 *  - an account with this email exists (e.g. signed up with a password) ->
 *    link it, but only if Google has verified the email, so an attacker
 *    can't hijack an existing account via an unverified email address
 *  - otherwise -> create a brand-new, password-less account
 *
 * A single query checks both `googleId` and `email` (rather than two
 * sequential round trips) since at most one of them can realistically match
 * under normal operation — both columns are unique, and a user's googleId is
 * only ever set together with (or onto) the row for their one email.
 */
export async function findOrCreateGoogleUser(profile: GoogleProfile) {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
  });

  if (existing?.googleId === profile.googleId) {
    return existing;
  }

  if (existing) {
    if (!profile.emailVerified) {
      throw new AppError(400, 'Google account email is not verified');
    }
    try {
      return await prisma.user.update({
        where: { id: existing.id },
        data: { googleId: profile.googleId, isEmailVerified: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // `googleId` is @unique, and this update is racing whatever else
        // might be claiming it concurrently — most plausibly the same
        // login double-firing (a double-click, two tabs), in which case
        // some other in-flight request already set this exact googleId on
        // this exact row, and re-reading it is the correct outcome, not a
        // failure. But it's also possible (correctly) rejected: this
        // googleId already belongs to a genuinely DIFFERENT user account —
        // that's a real conflict, not a race, and must not be silently
        // papered over by handing back the wrong user.
        const winner = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
        if (winner && winner.email === existing.email) {
          return winner;
        }
        throw new AppError(409, 'This Google account is already linked to a different user');
      }
      throw err;
    }
  }

  // Same TOCTOU shape as auth.service.ts's signup() (see EXPLANATION.md §10):
  // the findFirst above is a fast-path check, not a guard — two Google
  // logins for the same brand-new account arriving close together (a
  // double-click on "Continue with Google", or two tabs) can both see "no
  // existing user" and both reach this create(). Only one INSERT can
  // actually win against the `email`/`googleId` unique constraints; without
  // this catch, the loser would throw a raw, unhandled
  // PrismaClientKnownRequestError straight into errorHandler's generic `500`
  // branch, on what is, from the user's perspective, a successful login.
  try {
    return await prisma.user.create({
      data: {
        email: profile.email,
        googleId: profile.googleId,
        name: profile.name,
        isEmailVerified: profile.emailVerified,
        passwordHash: null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost the race — the concurrent request that won it already created
      // (or linked) the row we were about to create. Fetch and return that
      // instead of failing a login that, functionally, just succeeded
      // via the other request.
      const winner = await prisma.user.findFirst({
        where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
      });
      if (winner) {
        return winner;
      }
    }
    throw err;
  }
}

export interface GoogleLoginResult {
  user: PublicUser;
  tokens: TokenPair;
}

export async function loginWithGoogleCode(code: string): Promise<GoogleLoginResult> {
  const profile = await exchangeCodeForProfile(code);
  const user = await findOrCreateGoogleUser(profile);
  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}

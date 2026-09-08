import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
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
    email: payload.email.trim().toLowerCase(),
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
 */
export async function findOrCreateGoogleUser(profile: GoogleProfile) {
  const byGoogleId = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (byGoogleId) return byGoogleId;

  const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (byEmail) {
    if (!profile.emailVerified) {
      throw new AppError(400, 'Google account email is not verified');
    }
    return prisma.user.update({
      where: { id: byEmail.id },
      data: { googleId: profile.googleId, isEmailVerified: true },
    });
  }

  return prisma.user.create({
    data: {
      email: profile.email,
      googleId: profile.googleId,
      name: profile.name,
      isEmailVerified: profile.emailVerified,
      passwordHash: null,
    },
  });
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

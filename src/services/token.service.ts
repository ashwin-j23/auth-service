import crypto from 'crypto';
import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { signAccessToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function hashToken(rawToken: string): string {
  // Refresh tokens are high-entropy opaque strings, not JWTs — a plain
  // SHA-256 digest (no per-token salt needed) is enough to keep the DB copy
  // useless to an attacker who reads the table, while still allowing a fast
  // equality lookup on refresh.
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function refreshTokenExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return expiry;
}

/** Issues a fresh access + refresh token pair for a user (signup/login/OAuth). */
export async function issueTokenPair(user: User): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email });

  const rawRefreshToken = generateRawRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(rawRefreshToken),
      userId: user.id,
      expiresAt: refreshTokenExpiry(),
    },
  });

  return { accessToken, refreshToken: rawRefreshToken };
}

/**
 * Exchanges a still-valid refresh token for a new token pair, revoking the
 * old one in the same operation (rotation) so each refresh token can only
 * ever be used once. Throws AppError(401) for anything not usable.
 */
export async function rotateRefreshToken(rawRefreshToken: string): Promise<TokenPair> {
  const tokenHash = hashToken(rawRefreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) {
    throw new AppError(401, 'Invalid refresh token');
  }
  if (stored.revokedAt) {
    // Reuse of an already-rotated/revoked token is a signal the token was
    // stolen — revoke every other active token for this user as a precaution.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AppError(401, 'Refresh token has already been used');
  }
  if (stored.expiresAt < new Date()) {
    throw new AppError(401, 'Refresh token has expired');
  }

  const newRawRefreshToken = generateRawRefreshToken();
  const newTokenHash = hashToken(newRawRefreshToken);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
    }),
    prisma.refreshToken.create({
      data: {
        tokenHash: newTokenHash,
        userId: stored.userId,
        expiresAt: refreshTokenExpiry(),
      },
    }),
  ]);

  const accessToken = signAccessToken({ sub: stored.user.id, email: stored.user.email });
  return { accessToken, refreshToken: newRawRefreshToken };
}

/** Revokes a refresh token (logout). Silently no-ops if it's unknown already. */
export async function revokeRefreshToken(rawRefreshToken: string): Promise<void> {
  const tokenHash = hashToken(rawRefreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

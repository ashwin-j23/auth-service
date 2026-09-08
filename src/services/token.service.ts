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
 * Revokes every currently-active refresh token for a user. Called when a
 * used-and-revoked token is replayed — the standard response to a suspected
 * theft signal, since we can't tell "attacker replaying a stolen token" from
 * "legit client retried a request" any other way.
 */
async function revokeAllTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
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
    await revokeAllTokensForUser(stored.userId);
    throw new AppError(401, 'Refresh token has already been used');
  }
  if (stored.expiresAt < new Date()) {
    throw new AppError(401, 'Refresh token has expired');
  }

  const newRawRefreshToken = generateRawRefreshToken();
  const newTokenHash = hashToken(newRawRefreshToken);

  // Two concurrent calls can both reach this point holding the same
  // still-unrevoked `stored` row (read above), racing to rotate it — a
  // stolen-but-still-valid token replayed at the same moment a legitimate
  // client refreshes, for instance. An unconditional update here would let
  // both callers "win" and each walk away with a valid new token from one
  // old one, silently defeating the single-use guarantee.
  //
  // Guard against that with a conditional update — `revokedAt: null` in the
  // WHERE clause is re-checked against the row's *current* state at write
  // time, not the state read above, and Postgres serializes concurrent
  // UPDATEs to the same row: the second writer's WHERE clause sees the first
  // writer's committed change and matches zero rows. `count === 0` here
  // means this call lost that race, not that anything is wrong with the
  // token itself.
  const rotated = await prisma.$transaction(async (tx) => {
    const claim = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
    });
    if (claim.count === 0) {
      return false;
    }
    await tx.refreshToken.create({
      data: {
        tokenHash: newTokenHash,
        userId: stored.userId,
        expiresAt: refreshTokenExpiry(),
      },
    });
    return true;
  });

  if (!rotated) {
    await revokeAllTokensForUser(stored.userId);
    throw new AppError(401, 'Refresh token has already been used');
  }

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

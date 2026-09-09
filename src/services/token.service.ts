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
 *
 * Exported (not just used internally by rotateRefreshToken below) so
 * auth.service.ts's confirmPasswordReset can call the exact same mass-revoke
 * when a password is reset — whoever set the OLD password must not keep a
 * working session once control of the account changes hands.
 */
export async function revokeAllTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Logs a detected token-reuse event. This is, on this whole service, the
 * single most security-relevant thing that can happen — a refresh token
 * that was already rotated (i.e. already used once) coming back again is
 * the standard signal that a token was stolen and is being replayed by
 * someone other than its legitimate holder. Before this, `rotateRefreshToken`
 * responded correctly (revoking every session) but completely silently: no
 * log, no alert, nothing — a real compromise could go by with nobody on the
 * team ever finding out, short of a user complaining about being logged out.
 *
 * A plain structured console.error (this project has no logging/alerting
 * pipeline configured yet — see oauthHandoff.service.ts's store-full log for
 * the existing precedent) rather than throwing or swallowing: this must not
 * change the caller's behavior, only make the event observable.
 */
function logSuspectedTokenReuse(userId: string, reason: 'already-used' | 'lost-rotation-race'): void {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'refresh_token_reuse_detected',
      userId,
      reason,
      message:
        'A refresh token was replayed after being rotated/used — probable token theft. ' +
        'All sessions for this user have been revoked.',
      timestamp: new Date().toISOString(),
    }),
  );
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
    logSuspectedTokenReuse(stored.userId, 'already-used');
    await revokeAllTokensForUser(stored.userId);
    throw new AppError(401, 'Refresh token has already been used');
  }
  if (stored.expiresAt < new Date()) {
    throw new AppError(401, 'Refresh token has expired');
  }
  if (!stored.user.isActive) {
    // Closes the same gap login() guards against, on the other place a
    // disabled account could otherwise keep working indefinitely: without
    // this, an already-issued refresh token would happily keep minting
    // fresh access tokens for a disabled account forever, even though
    // login() itself now refuses that account from the front door. A
    // distinct message is fine here (unlike login's deliberately generic
    // one) — this isn't a public, guessable-credential endpoint; reaching
    // this line already requires possessing a specific, high-entropy
    // refresh token, so there's no meaningful enumeration risk in being
    // specific about why it stopped working.
    throw new AppError(401, 'This account is no longer active');
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
    logSuspectedTokenReuse(stored.userId, 'lost-rotation-race');
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

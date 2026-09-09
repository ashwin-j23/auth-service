import crypto from 'crypto';
import { Prisma, VerificationPurpose } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

const TOKEN_TTL_MS: Record<VerificationPurpose, number> = {
  [VerificationPurpose.EMAIL_VERIFICATION]: env.EMAIL_VERIFICATION_TOKEN_TTL_MS,
  [VerificationPurpose.PASSWORD_RESET]: env.PASSWORD_RESET_TOKEN_TTL_MS,
};

// Same rationale as token.service.ts's hashToken: an opaque, high-entropy
// value, not a JWT, so a plain unsalted SHA-256 digest is enough to keep the
// DB copy useless to anyone who reads the table while still allowing a fast
// equality lookup when the token comes back.
function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Creates a fresh single-use token for the given purpose and returns the
 * RAW value — this is the only place the raw value ever exists outside the
 * recipient's inbox; only its hash is persisted (mirrors
 * token.service.ts's refresh tokens).
 */
export async function createVerificationToken(
  userId: string,
  purpose: VerificationPurpose,
): Promise<string> {
  const rawToken = generateRawToken();
  await prisma.verificationToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      userId,
      purpose,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
    },
  });
  return rawToken;
}

/**
 * Consumes a token: it must exist, match the expected `purpose` (an
 * email-verification link can never be replayed to reset a password, or
 * vice versa), not be expired, and not have been used already — and this
 * marks it used in the same call rather than checking-then-marking as two
 * separate steps.
 *
 * That matters for the same reason token.service.ts's rotateRefreshToken
 * uses a conditional update instead of a plain read + write: two concurrent
 * requests holding the same still-unused token (a user double-clicking the
 * link, or a mail client that pre-fetches links) could otherwise both pass
 * the "is it used?" read before either commits its "mark used" write, and
 * both would walk away believing they legitimately consumed a single-use
 * token. The `updateMany` WHERE clause below re-checks `usedAt: null`
 * against the row's state *at write time*, so only one caller's update can
 * ever actually match.
 *
 * `client` defaults to the top-level `prisma` but accepts a
 * `Prisma.TransactionClient` too — auth.service.ts's confirmEmailVerification
 * and confirmPasswordReset both pass one, so that consuming the token and
 * applying its effect (marking the email verified; setting a new password)
 * commit as a single atomic unit. Without that, a failure of the SECOND
 * write would leave this token burned with no effect: single-use by
 * design, so there'd be no way to retry the same link, only to request an
 * entirely new one.
 */
export async function consumeVerificationToken(
  rawToken: string,
  purpose: VerificationPurpose,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ userId: string }> {
  const invalidToken = () => new AppError(400, 'Invalid or expired token');

  const tokenHash = hashToken(rawToken);
  const stored = await client.verificationToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.purpose !== purpose || stored.usedAt || stored.expiresAt < new Date()) {
    throw invalidToken();
  }

  const claim = await client.verificationToken.updateMany({
    where: { id: stored.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count === 0) {
    // Lost the race to claim it — from this caller's perspective that's
    // indistinguishable from "already used", which is exactly what it is.
    throw invalidToken();
  }

  return { userId: stored.userId };
}

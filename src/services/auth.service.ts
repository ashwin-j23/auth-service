import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { hashPassword, comparePassword } from '../utils/password';
import { normalizeEmail } from '../utils/email';
import { issueTokenPair, type TokenPair } from './token.service';
import { toPublicUser, type PublicUser } from '../utils/publicUser';

// Prisma's error code for "unique constraint violated" — see signup() below.
const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

// Bcrypt-compared (result discarded) against every login attempt for an
// email that doesn't exist, or exists but has no password set (a Google-only
// account) — see login() below. Computed once, lazily, the same way a real
// user's hash would be: this is NOT a hardcoded literal precisely so it goes
// through the exact same bcrypt cost factor as every genuine hash in this
// database (src/utils/password.ts's SALT_ROUNDS), rather than risking silent
// drift if that constant is ever tuned.
//
// Without this, login() used to return its generic 401 immediately for those
// two cases — no bcrypt call at all — while a real "wrong password" attempt
// against an existing account pays bcrypt's ~50-100ms cost first. That
// timing gap is a textbook account-enumeration side channel: an attacker
// can't read the (identical) response body to tell "unregistered email" from
// "wrong password", but they can just measure how long the response took.
// Running the same comparison against a decoy hash on the fast path closes
// that gap without changing anything the caller-visible response says.
const dummyPasswordHash = hashPassword('timing-attack-mitigation-decoy-password');

export async function signup(input: SignupInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);

  // This existence check is a fast-path only, not the actual guard against
  // duplicates — two signups for the same email can both pass it before
  // either INSERT commits (a real race, not just a theoretical one under
  // load). It exists purely to skip the cost of hashing a password for the
  // common, non-racing case. Deliberately specific message ("email already
  // in use" rather than a generic failure): this is a public signup form,
  // so confirming an email is already registered isn't a meaningful
  // information leak here, and a vague error would just confuse legitimate
  // users retrying signup.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await prisma.user.create({
      data: { email, passwordHash, name: input.name },
    });
  } catch (err) {
    // The database's own unique constraint on `email` (prisma/schema.prisma)
    // is the real source of truth for "no duplicates" — this catches the
    // race the findUnique check above can't close, and turns Postgres's raw
    // constraint violation into the same clean 409 rather than letting it
    // fall through to errorHandler's generic 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw new AppError(409, 'An account with this email already exists');
    }
    throw err;
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  // Same generic message whether the account doesn't exist, has no password
  // (Google-only account), the password is wrong, or the account is
  // currently locked out — unlike signup, this is an attacker-facing
  // endpoint where confirming account existence (or lockout state, which
  // just as surely confirms existence) would aid credential-stuffing/
  // enumeration.
  const invalidCredentials = () => new AppError(401, 'Invalid email or password');

  if (!user || !user.passwordHash) {
    // No account, or a Google-only account — either way there's no password
    // to guess against and no row to track failed attempts on, so lockout
    // doesn't apply; this is the same "nothing to do" case it always was.
    // The bcrypt compare against a decoy hash below is pure timing cover
    // (see dummyPasswordHash above) — its result is never inspected.
    await comparePassword(input.password, await dummyPasswordHash);
    throw invalidCredentials();
  }

  if (!user.isActive) {
    // Same generic message as everything else here, deliberately — a
    // disabled account is treated exactly like a nonexistent one from the
    // outside, for the same enumeration-resistance reason. Checked before
    // lockout/password logic runs at all: there's no reason to track failed
    // attempts, or pay bcrypt's cost, against an account that can never
    // succeed regardless of what's typed.
    throw invalidCredentials();
  }

  const isLocked = user.lockedUntil !== null && user.lockedUntil > new Date();
  if (isLocked) {
    // Rejected before ever touching bcrypt — on top of not leaking lockout
    // state via a different message, this also means a locked-out account
    // doesn't pay comparePassword's ~50-100ms cost per guess, which is a
    // small extra brake on an attacker hammering it during the lockout window.
    throw invalidCredentials();
  }

  const passwordMatches = await comparePassword(input.password, user.passwordHash);

  if (!passwordMatches) {
    // Account-level lockout — a self-clearing throttle *per account*, on
    // top of (not instead of) the per-IP rate limiting in
    // rateLimit.middleware.ts. That limiter can't stop an attacker who
    // spreads guesses across many IPs against one specific account; this
    // closes that gap by counting failures on the account itself.
    //
    // `user.lockedUntil !== null` (checked here, not just "is it still in
    // the future" — already ruled out above) is the signal an earlier
    // lockout happened and has since expired: that gets a fresh count
    // rather than starting permanently pinned at the limit, since without
    // this a user who once got locked out would re-lock on their very next
    // mistake, forever, instead of getting a normal-length grace window again.
    const attemptsBeforeThisOne = user.lockedUntil !== null ? 0 : user.failedLoginAttempts;
    const attempts = attemptsBeforeThisOne + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= env.LOCKOUT_MAX_ATTEMPTS
            ? new Date(Date.now() + env.LOCKOUT_DURATION_MS)
            : null,
      },
    });
    throw invalidCredentials();
  }

  // Correct password — fully clear any lockout state, successful or not
  // (an expired-but-still-set lockedUntil is cleared here too, not just a
  // live one), so a legitimate login always starts the count over at zero.
  if (user.failedLoginAttempts > 0 || user.lockedUntil !== null) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}

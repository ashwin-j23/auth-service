import { Prisma, VerificationPurpose } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { hashPassword, comparePassword } from '../utils/password';
import { normalizeEmail } from '../utils/email';
import { issueTokenPair, revokeAllTokensForUser, type TokenPair } from './token.service';
import { createVerificationToken, consumeVerificationToken } from './verification.service';
import { sendVerificationEmail, sendPasswordResetEmail } from './mail.service';
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

  // Best-effort — see requestEmailVerification below for the exact same
  // pattern used on a resend. A failed verification email must never fail
  // signup itself: the account is fully created and usable either way, and
  // the user can always request a fresh link later.
  try {
    const verificationToken = await createVerificationToken(
      user.id,
      VerificationPurpose.EMAIL_VERIFICATION,
    );
    await sendVerificationEmail(user.email, verificationToken);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`auth.service: failed to send signup verification email for user ${user.id}`, err);
  }

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
    // A SINGLE atomic UPDATE, not a JS-computed value written back, and not
    // split across two separate writes either. Both of those were real
    // races:
    //  - An earlier version computed `attempts = current + 1` in JS from the
    //    row read at the top of this function, then wrote that literal
    //    value back — several wrong-password requests fired concurrently
    //    (trivial for an attacker to do) could all read the same starting
    //    count before any of them committed, collapsing N failures into the
    //    count advancing by just 1.
    //  - A version after that fixed the increment itself (Prisma's atomic
    //    `{ increment: 1 }`) but still used a SECOND, separate write to set
    //    `lockedUntil` once the returned count crossed the threshold — if
    //    that second write failed (or simply hadn't happened yet when some
    //    other request read this row), the account could sit AT the
    //    threshold but still unlocked. The "previous lockout expired, reset
    //    to a fresh count" branch had the same shape of bug one level up:
    //    it wrote a literal `failedLoginAttempts: 1`, so two requests
    //    racing right at that reset boundary could each write `1` and one
    //    of their failures would vanish instead of counting.
    //
    // One `UPDATE` closes all three at once: Postgres evaluates the whole
    // SET clause — the reset-vs-increment decision AND the lockout decision
    // — against this row's actual state at the moment it acquires the row
    // lock for this statement, so there's no window between "compute the
    // new count" and "decide whether to lock" for a second write to fail
    // or another request to interleave.
    //
    // `"lockedUntil" IS NOT NULL AND "lockedUntil" > ${now}` — an ACTIVE
    // lock, not just any non-null one — is checked FIRST and, if true,
    // preserves the existing `lockedUntil` untouched rather than
    // recomputing it. Checking only `IS NOT NULL` (an earlier version of
    // this statement) can't tell "this lock expired a while ago" apart
    // from "a concurrent sibling request just now set this lock, this very
    // millisecond, because the count crossed the threshold" — the latter
    // is a real, easy-to-hit case: several requests can all read the row
    // (via the `isLocked` check above, which runs before this) while it's
    // still unlocked, then race each other into this UPDATE; whichever
    // commits first sets `lockedUntil` to a FUTURE date, and every sibling
    // still queued behind it would otherwise see "lockedUntil is set" and
    // wrongly treat that fresh, still-active lock as an EXPIRED one —
    // resetting the count back down to 1 and clearing the very lock a
    // sibling request just correctly set, one row-lock-acquisition later.
    // Reproduced directly against a real Postgres instance: 10 truly
    // concurrent wrong-password requests against a fresh account
    // intermittently ended with the account unlocked and a failure count
    // well under the threshold, before this check was added.
    //
    // "the current time" here is a JS `Date` BOUND AS A PARAMETER
    // (`${now}`), never SQL's `NOW()` — this isn't just style consistency
    // with `isLocked` above. `lockedUntil` is a `TIMESTAMP WITHOUT TIME
    // ZONE`; on a connection whose session `TimeZone` isn't UTC (verified
    // live: this DB's isn't), a value written via `NOW()` — evaluated
    // server-side against that session setting, then implicitly cast to
    // the naive column — and a value written via a bound Date parameter
    // (Prisma's own read/write path, confirmed to round-trip correctly on
    // its own) are NOT guaranteed to agree once read back through Prisma:
    // forcing `lockedUntil` into the past with `NOW() - interval '1
    // second'` in raw SQL, then having this app read it back moments
    // later, showed a Date still hours in the future — a timezone offset
    // applied going in but never reversed coming out. The app itself never
    // writes through `NOW()` (every write, including this statement, binds
    // a JS Date), so this specific mismatch has no path into production —
    // but it costs nothing to bind every comparison here through the exact
    // same `${now}` this function already needs, rather than leaning on a
    // Postgres session setting this code doesn't control and has no way to
    // verify from here.
    const now = new Date();
    const lockUntilIfThresholdReached = new Date(now.getTime() + env.LOCKOUT_DURATION_MS);
    await prisma.$executeRaw`
      UPDATE users
      SET "failedLoginAttempts" = CASE
            WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1
            ELSE "failedLoginAttempts" + 1
          END,
          "lockedUntil" = CASE
            WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > ${now} THEN "lockedUntil"
            WHEN (
              CASE WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1
                   ELSE "failedLoginAttempts" + 1
              END
            ) >= ${env.LOCKOUT_MAX_ATTEMPTS}
            THEN ${lockUntilIfThresholdReached}
            ELSE NULL
          END
      WHERE id = ${user.id}
    `;
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

/**
 * Sends (or resends) an email-verification link. Deliberately silent and
 * same-shaped for every outcome — no such account, already verified, or a
 * fresh link genuinely sent — because this is an unauthenticated, public
 * endpoint: the response must not become an account-existence oracle any
 * more than login()'s generic 401 above is. Callers always get the same
 * "if applicable, check your email" response; see auth.controller.ts.
 */
export async function requestEmailVerification(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.isEmailVerified) {
    return;
  }
  const token = await createVerificationToken(user.id, VerificationPurpose.EMAIL_VERIFICATION);
  await sendVerificationEmail(user.email, token);
}

/**
 * Consumes an email-verification token and marks the account verified.
 *
 * Both steps run in one transaction: consuming the token burns it
 * (single-use, irreversible) whether or not the follow-up write succeeds,
 * so doing them separately would mean a failed `user.update` — a
 * transient DB error, say — leaves the account unverified with its one
 * link already spent and no way to retry it, only to request a whole new
 * one. Committing them together means either both happen or neither does.
 */
export async function confirmEmailVerification(rawToken: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { userId } = await consumeVerificationToken(
      rawToken,
      VerificationPurpose.EMAIL_VERIFICATION,
      tx,
    );
    await tx.user.update({ where: { id: userId }, data: { isEmailVerified: true } });
  });
}

/**
 * Requests a password-reset link. Same enumeration-resistant shape as
 * requestEmailVerification above: no account with this email is not
 * distinguishable, from the response, from a fresh link genuinely sent.
 */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return;
  }
  const token = await createVerificationToken(user.id, VerificationPurpose.PASSWORD_RESET);
  await sendPasswordResetEmail(user.email, token);
}

/**
 * Consumes a password-reset token, sets the new password, and:
 *  - marks the account's email verified — successfully consuming this token
 *    IS proof of ownership of the address (it could only have been
 *    consumed by whoever received it there), which is exactly the signal
 *    google.service.ts's findOrCreateGoogleUser now requires before it will
 *    link a Google identity onto this account (see that file's account-
 *    takeover fix). This is the intended way out of that block: if an
 *    attacker signed up first with someone else's email, the real owner
 *    resetting the password here both reclaims the account AND clears the
 *    way for their Google sign-in to link cleanly next time.
 *  - clears any stale lockout state, so the new password isn't immediately
 *    unusable because of failed attempts against the old one.
 *  - revokes every outstanding refresh token for the account — whoever set
 *    the OLD password (possibly an attacker) must not keep a working
 *    session after control of the account changes hands here.
 *
 * All three DB writes (consuming the token, updating the user row,
 * revoking sessions) run in one transaction. Without that, a failure of
 * just the LAST step — after the password update already committed — would
 * leave the new password active while refresh tokens issued under the old
 * one stayed valid: exactly the "attacker's session survives a reset"
 * outcome this function's whole second half exists to prevent. Committing
 * every effect of "this token was consumed" together means the token is
 * never burned without also actually finishing the reset it paid for.
 */
export async function confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const { userId } = await consumeVerificationToken(rawToken, VerificationPurpose.PASSWORD_RESET, tx);
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        isEmailVerified: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await revokeAllTokensForUser(userId, tx);
  });
}

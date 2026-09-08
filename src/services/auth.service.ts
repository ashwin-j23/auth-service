import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
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
  // (Google-only account), or the password is wrong — unlike signup, this is
  // an attacker-facing endpoint where confirming account existence would aid
  // credential-stuffing/enumeration.
  const invalidCredentials = () => new AppError(401, 'Invalid email or password');

  if (!user || !user.passwordHash) {
    throw invalidCredentials();
  }

  const passwordMatches = await comparePassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}

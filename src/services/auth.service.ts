import { prisma } from '../lib/prisma';
import { AppError } from '../utils/AppError';
import { hashPassword, comparePassword } from '../utils/password';
import { issueTokenPair, type TokenPair } from './token.service';
import { toPublicUser, type PublicUser } from '../utils/publicUser';

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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberately specific ("email already in use" rather than a generic
    // failure): this is a public signup form, so confirming an email is
    // already registered isn't a meaningful information leak here, and a
    // vague error would just confuse legitimate users retrying signup.
    throw new AppError(409, 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name: input.name },
  });

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

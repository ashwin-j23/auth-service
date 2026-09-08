import bcrypt from 'bcryptjs';

// Cost factor for bcrypt. 12 is a reasonable default in 2026 — high enough to
// be slow for an attacker doing offline cracking, low enough not to make
// login/signup noticeably slow for a real user.
const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function comparePassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}

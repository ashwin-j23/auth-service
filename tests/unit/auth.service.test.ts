import type { User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { signup, login } from '../../src/services/auth.service';
import { hashPassword } from '../../src/utils/password';
import { AppError } from '../../src/utils/AppError';

// issueTokenPair hits prisma.refreshToken.create internally — stub it at the
// module boundary so these tests stay focused on signup/login logic rather
// than re-asserting token-service behaviour (already covered separately).
jest.mock('../../src/services/token.service', () => ({
  issueTokenPair: jest.fn().mockResolvedValue({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
  }),
}));

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'jane@example.com',
    passwordHash: null,
    name: 'Jane',
    googleId: null,
    isEmailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('auth.service', () => {
  describe('signup', () => {
    it('rejects when the email is already registered', async () => {
      prismaMock.user.findUnique.mockResolvedValue(buildUser());

      await expect(
        signup({ email: 'jane@example.com', password: 'password123' }),
      ).rejects.toMatchObject(new AppError(409, 'An account with this email already exists'));
    });

    it('creates a user with a hashed (not plain-text) password and returns tokens', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      // Cast to `any`: Prisma's generated `.create()` return type is a
      // fluent "thenable-with-relation-methods" client, not a plain
      // Promise<User> — jest-mock-extended's mockImplementation types
      // against that exact fluent shape, which a plain async fn can't
      // satisfy structurally even though it resolves correctly at runtime.
      prismaMock.user.create.mockImplementation((async ({ data }: any) => buildUser({
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name,
      })) as any);

      const result = await signup({
        email: '  Jane@Example.com  ',
        password: 'plain-text-password',
        name: 'Jane',
      });

      const createArgs = prismaMock.user.create.mock.calls[0][0];
      expect(createArgs.data.email).toBe('jane@example.com'); // trimmed + lowercased
      expect(createArgs.data.passwordHash).not.toBe('plain-text-password');

      expect(result.user).not.toHaveProperty('passwordHash'); // never leaks the hash
      expect(result.tokens).toEqual({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
      });
    });
  });

  describe('login', () => {
    it('rejects when no account exists for the email', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      await expect(login({ email: 'nobody@example.com', password: 'x' })).rejects.toMatchObject(
        new AppError(401, 'Invalid email or password'),
      );
    });

    it('rejects a Google-only account (no password set) with the same generic message', async () => {
      prismaMock.user.findUnique.mockResolvedValue(buildUser({ passwordHash: null }));
      await expect(login({ email: 'jane@example.com', password: 'x' })).rejects.toMatchObject(
        new AppError(401, 'Invalid email or password'),
      );
    });

    it('rejects an incorrect password', async () => {
      const passwordHash = await hashPassword('the-real-password');
      prismaMock.user.findUnique.mockResolvedValue(buildUser({ passwordHash }));

      await expect(
        login({ email: 'jane@example.com', password: 'wrong-password' }),
      ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));
    });

    it('returns the user and tokens on a correct password', async () => {
      const passwordHash = await hashPassword('the-real-password');
      prismaMock.user.findUnique.mockResolvedValue(buildUser({ passwordHash }));

      const result = await login({ email: 'jane@example.com', password: 'the-real-password' });

      expect(result.user.email).toBe('jane@example.com');
      expect(result.tokens.accessToken).toBe('fake-access-token');
    });
  });
});

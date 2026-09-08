import { Prisma, type User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { signup, login } from '../../src/services/auth.service';
import * as passwordUtils from '../../src/utils/password';
import { hashPassword } from '../../src/utils/password';
import { AppError } from '../../src/utils/AppError';
import { env } from '../../src/config/env';

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
    failedLoginAttempts: 0,
    lockedUntil: null,
    isActive: true,
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

    it('closes the signup race: a duplicate caught only by the DB constraint still gets a clean 409', async () => {
      // Simulates two concurrent signups for the same email: this call's
      // findUnique still sees no existing row (the other caller hasn't
      // committed yet), so it proceeds to create() — which is where Postgres's
      // real unique constraint on `email` catches it.
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        signup({ email: 'jane@example.com', password: 'password123' }),
      ).rejects.toMatchObject(new AppError(409, 'An account with this email already exists'));
    });

    it('re-throws an unrelated database error rather than misreporting it as a duplicate', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(new Error('connection reset'));

      await expect(
        signup({ email: 'jane@example.com', password: 'password123' }),
      ).rejects.toThrow('connection reset');
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

    it('rejects a disabled account with the SAME generic message, even with the correct password', async () => {
      const passwordHash = await hashPassword('the-real-password');
      const compareSpy = jest.spyOn(passwordUtils, 'comparePassword');
      prismaMock.user.findUnique.mockResolvedValue(
        buildUser({ passwordHash, isActive: false }),
      );

      await expect(
        login({ email: 'jane@example.com', password: 'the-real-password' }),
      ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

      // Rejected before even comparing the password, and without touching
      // lockout bookkeeping for an account that can never succeed anyway.
      expect(compareSpy).not.toHaveBeenCalled();
      expect(prismaMock.user.update).not.toHaveBeenCalled();
      compareSpy.mockRestore();
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

    describe('account lockout', () => {
      it('increments failedLoginAttempts on a wrong password, without locking yet', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({ passwordHash, failedLoginAttempts: 1 }),
        );

        await expect(
          login({ email: 'jane@example.com', password: 'wrong' }),
        ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

        expect(prismaMock.user.update).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          data: { failedLoginAttempts: 2, lockedUntil: null },
        });
      });

      it('locks the account once LOCKOUT_MAX_ATTEMPTS is reached', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({ passwordHash, failedLoginAttempts: env.LOCKOUT_MAX_ATTEMPTS - 1 }),
        );

        await expect(
          login({ email: 'jane@example.com', password: 'wrong' }),
        ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

        const updateArgs = prismaMock.user.update.mock.calls[0][0];
        expect(updateArgs.data.failedLoginAttempts).toBe(env.LOCKOUT_MAX_ATTEMPTS);
        expect(updateArgs.data.lockedUntil).toBeInstanceOf(Date);
        const lockedUntil = updateArgs.data.lockedUntil as Date;
        expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
        expect(lockedUntil.getTime()).toBeLessThanOrEqual(
          Date.now() + env.LOCKOUT_DURATION_MS + 1000, // +1s slack for test execution time
        );
      });

      it('rejects a currently-locked account with the SAME generic message, without ever calling comparePassword', async () => {
        const passwordHash = await hashPassword('the-real-password');
        const compareSpy = jest.spyOn(passwordUtils, 'comparePassword');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({
            passwordHash,
            failedLoginAttempts: env.LOCKOUT_MAX_ATTEMPTS,
            lockedUntil: new Date(Date.now() + 60_000), // still locked for another minute
          }),
        );

        // Using the CORRECT password on purpose — even the right password
        // must not get in while locked.
        await expect(
          login({ email: 'jane@example.com', password: 'the-real-password' }),
        ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

        expect(compareSpy).not.toHaveBeenCalled();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
        compareSpy.mockRestore();
      });

      it('gives a fresh attempt count once a previous lockout has expired, rather than re-locking instantly', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({
            passwordHash,
            failedLoginAttempts: env.LOCKOUT_MAX_ATTEMPTS, // was at the limit...
            lockedUntil: new Date(Date.now() - 1000), // ...but that lock expired 1s ago
          }),
        );

        await expect(
          login({ email: 'jane@example.com', password: 'still-wrong' }),
        ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

        // Fresh count (1), not env.LOCKOUT_MAX_ATTEMPTS + 1 — and NOT
        // re-locked immediately just because the stored count was at the
        // limit.
        expect(prismaMock.user.update).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          data: { failedLoginAttempts: 1, lockedUntil: null },
        });
      });

      it('fully clears lockout state on a successful login after prior failed attempts', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({ passwordHash, failedLoginAttempts: 3 }),
        );

        await login({ email: 'jane@example.com', password: 'the-real-password' });

        expect(prismaMock.user.update).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          data: { failedLoginAttempts: 0, lockedUntil: null },
        });
      });

      it('does not bother writing to the database on a successful login with a clean history', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(buildUser({ passwordHash }));

        await login({ email: 'jane@example.com', password: 'the-real-password' });

        expect(prismaMock.user.update).not.toHaveBeenCalled();
      });

      it('does not track lockout at all for a nonexistent account or a Google-only account', async () => {
        prismaMock.user.findUnique.mockResolvedValue(null);
        await expect(login({ email: 'nobody@example.com', password: 'x' })).rejects.toThrow();
        expect(prismaMock.user.update).not.toHaveBeenCalled();

        prismaMock.user.findUnique.mockResolvedValue(buildUser({ passwordHash: null }));
        await expect(login({ email: 'jane@example.com', password: 'x' })).rejects.toThrow();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
      });
    });
  });
});

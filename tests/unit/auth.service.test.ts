import { Prisma, VerificationPurpose, type User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import {
  signup,
  login,
  requestEmailVerification,
  confirmEmailVerification,
  requestPasswordReset,
  confirmPasswordReset,
} from '../../src/services/auth.service';
import * as passwordUtils from '../../src/utils/password';
import { hashPassword } from '../../src/utils/password';
import { AppError } from '../../src/utils/AppError';
import { env } from '../../src/config/env';

// issueTokenPair/revokeAllTokensForUser hit prisma.refreshToken.* internally
// — stub the module boundary so these tests stay focused on
// signup/login/verification logic rather than re-asserting token-service
// behaviour (already covered separately, tests/unit/token.service.test.ts).
jest.mock('../../src/services/token.service', () => ({
  issueTokenPair: jest.fn().mockResolvedValue({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
  }),
  revokeAllTokensForUser: jest.fn().mockResolvedValue(undefined),
}));

// createVerificationToken/consumeVerificationToken hit prisma.verificationToken.*
// internally — same reasoning, and covered separately in
// tests/unit/verification.service.test.ts.
jest.mock('../../src/services/verification.service', () => ({
  createVerificationToken: jest.fn().mockResolvedValue('fake-verification-token'),
  consumeVerificationToken: jest.fn(),
}));

// Actually sending mail (mail.service.ts) hits the network (Ethereal) — must
// never run in a unit test. Covered separately, and only ever asserted here
// as "was this called", never actually executed.
jest.mock('../../src/services/mail.service', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

import { createVerificationToken, consumeVerificationToken } from '../../src/services/verification.service';
import { sendVerificationEmail, sendPasswordResetEmail } from '../../src/services/mail.service';

const mockCreateVerificationToken = createVerificationToken as jest.Mock;
const mockConsumeVerificationToken = consumeVerificationToken as jest.Mock;
const mockSendVerificationEmail = sendVerificationEmail as jest.Mock;
const mockSendPasswordResetEmail = sendPasswordResetEmail as jest.Mock;

// confirmEmailVerification/confirmPasswordReset both run their work inside
// `prisma.$transaction(async (tx) => {...})` — an unconfigured mock of
// `$transaction` (jest-mock-extended's default) never actually invokes that
// callback, which would make every write inside it silently not happen.
// Standing this passthrough up here (rather than per-test) means `tx` is
// just `prismaMock` itself, so assertions on `prismaMock.user.update` etc.
// still work unchanged for code that used to run outside a transaction.
beforeEach(() => {
  prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock));
});

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

      // The email-verification blocker fix: signup now issues a
      // verification token and emails it, best-effort.
      expect(mockCreateVerificationToken).toHaveBeenCalledWith(
        'user-1',
        VerificationPurpose.EMAIL_VERIFICATION,
      );
      expect(mockSendVerificationEmail).toHaveBeenCalledWith(
        'jane@example.com',
        'fake-verification-token',
      );
    });

    it('still succeeds (and still returns tokens) if the verification email fails to send', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockImplementation((async ({ data }: any) => buildUser({
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name,
      })) as any);
      mockCreateVerificationToken.mockRejectedValueOnce(new Error('db unavailable'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await signup({ email: 'jane@example.com', password: 'password123' });

      expect(result.tokens.accessToken).toBe('fake-access-token');
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
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
      prismaMock.user.update.mockResolvedValue(buildUser({ passwordHash, failedLoginAttempts: 1 }));

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
      // The reset-vs-increment-vs-lock decision now lives entirely inside
      // ONE raw SQL statement (see login()'s comment) rather than being
      // split across a read-then-JS-decide-then-write, or even across two
      // separate atomic writes — both earlier shapes had a real race
      // between concurrent wrong-password requests that this collapses
      // into a single UPDATE. That also means the actual CASE-expression
      // branching (increment vs. reset-after-expiry; lock vs. not) is
      // evaluated BY POSTGRES, not by this application code, so a mocked
      // Prisma client can't exercise that branching itself — these tests
      // instead verify the *shape* of the call (one write, correct
      // parameters), and the actual branching was verified end to end
      // against a real Postgres instance (concurrent wrong-password
      // requests correctly accumulating and locking the account — see the
      // PR description).
      it('issues exactly one atomic write on a wrong password, with the user id, lockout threshold, and a future lock-until timestamp as parameters', async () => {
        const passwordHash = await hashPassword('the-real-password');
        prismaMock.user.findUnique.mockResolvedValue(
          buildUser({ passwordHash, failedLoginAttempts: 1 }),
        );
        prismaMock.$executeRaw.mockResolvedValue(1);

        await expect(
          login({ email: 'jane@example.com', password: 'wrong' }),
        ).rejects.toMatchObject(new AppError(401, 'Invalid email or password'));

        // No `user.update` call at all for this path any more — replaced
        // entirely by the single raw statement below.
        expect(prismaMock.user.update).not.toHaveBeenCalled();
        expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
        const [, ...values] = prismaMock.$executeRaw.mock.calls[0] as unknown[];
        expect(values).toContain('user-1');
        expect(values).toContain(env.LOCKOUT_MAX_ATTEMPTS);
        // The statement binds "now" (the reference instant, used for every
        // comparison in it — see its comment on why NOT SQL's `NOW()`) more
        // than once, alongside the one lock-until-if-locked value — the
        // furthest-in-the-future Date among all of them has to be that
        // lock-until value specifically.
        const dateValues = values.filter((v): v is Date => v instanceof Date);
        expect(dateValues.length).toBeGreaterThanOrEqual(2);
        const lockUntilValue = dateValues.reduce((max, d) => (d > max ? d : max));
        expect(lockUntilValue.getTime()).toBeGreaterThan(Date.now());
        expect(lockUntilValue.getTime()).toBeLessThanOrEqual(
          Date.now() + env.LOCKOUT_DURATION_MS + 1000, // +1s slack for test execution time
        );
      });

      it('rejects a currently-locked account with the SAME generic message, without ever calling comparePassword or writing anything', async () => {
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
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
        compareSpy.mockRestore();
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

  describe('requestEmailVerification', () => {
    it('creates a token and emails it for an existing, unverified account', async () => {
      prismaMock.user.findUnique.mockResolvedValue(
        buildUser({ isEmailVerified: false }),
      );

      await requestEmailVerification('  Jane@Example.com  ');

      expect(mockCreateVerificationToken).toHaveBeenCalledWith(
        'user-1',
        VerificationPurpose.EMAIL_VERIFICATION,
      );
      expect(mockSendVerificationEmail).toHaveBeenCalledWith(
        'jane@example.com',
        'fake-verification-token',
      );
    });

    // Same enumeration-resistant shape as login()'s generic 401: neither of
    // these "nothing to do" cases is distinguishable from a genuinely-sent
    // link by the caller — both just silently return.
    it('does nothing for a nonexistent account, without throwing', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(requestEmailVerification('nobody@example.com')).resolves.toBeUndefined();
      expect(mockCreateVerificationToken).not.toHaveBeenCalled();
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('does nothing for an already-verified account', async () => {
      prismaMock.user.findUnique.mockResolvedValue(buildUser({ isEmailVerified: true }));

      await requestEmailVerification('jane@example.com');

      expect(mockCreateVerificationToken).not.toHaveBeenCalled();
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('confirmEmailVerification', () => {
    it('marks the account verified once the token is consumed', async () => {
      mockConsumeVerificationToken.mockResolvedValue({ userId: 'user-1' });

      await confirmEmailVerification('raw-token');

      // Third arg is the transaction client (`tx` — here, `prismaMock`
      // itself, per the passthrough above) that both this call and the
      // user.update below must share, so either both commit or neither does.
      expect(mockConsumeVerificationToken).toHaveBeenCalledWith(
        'raw-token',
        VerificationPurpose.EMAIL_VERIFICATION,
        prismaMock,
      );
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { isEmailVerified: true },
      });
    });

    it('propagates an invalid/expired/already-used token as-is', async () => {
      mockConsumeVerificationToken.mockRejectedValue(new AppError(400, 'Invalid or expired token'));

      await expect(confirmEmailVerification('bad-token')).rejects.toMatchObject(
        new AppError(400, 'Invalid or expired token'),
      );
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });
  });

  describe('requestPasswordReset', () => {
    it('creates a token and emails it for an existing account', async () => {
      prismaMock.user.findUnique.mockResolvedValue(buildUser());

      await requestPasswordReset('jane@example.com');

      expect(mockCreateVerificationToken).toHaveBeenCalledWith(
        'user-1',
        VerificationPurpose.PASSWORD_RESET,
      );
      expect(mockSendPasswordResetEmail).toHaveBeenCalledWith(
        'jane@example.com',
        'fake-verification-token',
      );
    });

    it('does nothing for a nonexistent account, without throwing (no enumeration signal)', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
      expect(mockCreateVerificationToken).not.toHaveBeenCalled();
      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('confirmPasswordReset', () => {
    it('sets a new (hashed) password, marks the email verified, clears lockout state, and revokes every session', async () => {
      mockConsumeVerificationToken.mockResolvedValue({ userId: 'user-1' });
      const { revokeAllTokensForUser } = jest.requireMock('../../src/services/token.service') as {
        revokeAllTokensForUser: jest.Mock;
      };

      await confirmPasswordReset('raw-token', 'brand-new-password');

      // Third arg on both calls below is the shared transaction client
      // (`tx` — here, `prismaMock`, per the passthrough above): consuming
      // the token, updating the user, and revoking sessions all commit
      // together or not at all.
      expect(mockConsumeVerificationToken).toHaveBeenCalledWith(
        'raw-token',
        VerificationPurpose.PASSWORD_RESET,
        prismaMock,
      );
      const updateArgs = prismaMock.user.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 'user-1' });
      expect(updateArgs.data.passwordHash).not.toBe('brand-new-password'); // hashed, not plain-text
      expect(updateArgs.data.isEmailVerified).toBe(true);
      expect(updateArgs.data.failedLoginAttempts).toBe(0);
      expect(updateArgs.data.lockedUntil).toBeNull();
      expect(revokeAllTokensForUser).toHaveBeenCalledWith('user-1', prismaMock);
    });

    it('propagates an invalid/expired/already-used token as-is, without touching the user row', async () => {
      mockConsumeVerificationToken.mockRejectedValue(new AppError(400, 'Invalid or expired token'));

      await expect(confirmPasswordReset('bad-token', 'brand-new-password')).rejects.toMatchObject(
        new AppError(400, 'Invalid or expired token'),
      );
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });
  });
});

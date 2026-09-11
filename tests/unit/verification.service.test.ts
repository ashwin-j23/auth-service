import { VerificationPurpose } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import {
  createVerificationToken,
  consumeVerificationToken,
} from '../../src/services/verification.service';
import { AppError } from '../../src/utils/AppError';

function fakeStoredToken(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'vt-1',
    tokenHash: 'irrelevant-because-mocked',
    userId: 'user-1',
    purpose: VerificationPurpose.EMAIL_VERIFICATION,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('verification.service', () => {
  describe('createVerificationToken', () => {
    it('persists a hashed token (never the raw value) and returns the raw value', async () => {
      prismaMock.verificationToken.create.mockResolvedValue(fakeStoredToken() as any);

      const rawToken = await createVerificationToken('user-1', VerificationPurpose.EMAIL_VERIFICATION);

      expect(typeof rawToken).toBe('string');
      expect(rawToken.length).toBeGreaterThan(0);
      const createArgs = prismaMock.verificationToken.create.mock.calls[0][0];
      expect(createArgs.data.tokenHash).not.toBe(rawToken);
      expect(createArgs.data.userId).toBe('user-1');
      expect(createArgs.data.purpose).toBe(VerificationPurpose.EMAIL_VERIFICATION);
      expect(createArgs.data.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('consumeVerificationToken', () => {
    it('rejects an unknown token', async () => {
      prismaMock.verificationToken.findUnique.mockResolvedValue(null);

      await expect(
        consumeVerificationToken('does-not-exist', VerificationPurpose.EMAIL_VERIFICATION),
      ).rejects.toMatchObject(new AppError(400, 'Invalid or expired token'));
    });

    it('rejects a token of the WRONG purpose (an email-verification link cannot reset a password)', async () => {
      prismaMock.verificationToken.findUnique.mockResolvedValue(
        fakeStoredToken({ purpose: VerificationPurpose.EMAIL_VERIFICATION }) as any,
      );

      await expect(
        consumeVerificationToken('some-token', VerificationPurpose.PASSWORD_RESET),
      ).rejects.toMatchObject(new AppError(400, 'Invalid or expired token'));
      expect(prismaMock.verificationToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      prismaMock.verificationToken.findUnique.mockResolvedValue(
        fakeStoredToken({ expiresAt: new Date(Date.now() - 1000) }) as any,
      );

      await expect(
        consumeVerificationToken('expired-token', VerificationPurpose.EMAIL_VERIFICATION),
      ).rejects.toMatchObject(new AppError(400, 'Invalid or expired token'));
    });

    it('rejects an already-used token', async () => {
      prismaMock.verificationToken.findUnique.mockResolvedValue(
        fakeStoredToken({ usedAt: new Date() }) as any,
      );

      await expect(
        consumeVerificationToken('used-token', VerificationPurpose.EMAIL_VERIFICATION),
      ).rejects.toMatchObject(new AppError(400, 'Invalid or expired token'));
    });

    it('consumes a valid token exactly once, returning the owning userId', async () => {
      const stored = fakeStoredToken();
      prismaMock.verificationToken.findUnique.mockResolvedValue(stored as any);
      prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await consumeVerificationToken(
        'valid-token',
        VerificationPurpose.EMAIL_VERIFICATION,
      );

      expect(result).toEqual({ userId: 'user-1' });
      expect(prismaMock.verificationToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: stored.id, usedAt: null } }),
      );
    });

    it('closes the double-consume race: a lost claim (count 0) is rejected, not silently accepted', async () => {
      // Simulates two concurrent consume calls for the same token (a
      // double-click, or a mail client pre-fetching the link): this call's
      // findUnique still sees usedAt: null (the other caller hasn't
      // committed yet), but its own conditional updateMany loses the claim.
      const stored = fakeStoredToken();
      prismaMock.verificationToken.findUnique.mockResolvedValue(stored as any);
      prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        consumeVerificationToken('raced-token', VerificationPurpose.EMAIL_VERIFICATION),
      ).rejects.toMatchObject(new AppError(400, 'Invalid or expired token'));
    });
  });
});

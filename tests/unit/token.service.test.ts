import type { User, RefreshToken } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import {
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../../src/services/token.service';
import { verifyAccessToken } from '../../src/utils/jwt';
import { AppError } from '../../src/utils/AppError';

const fakeUser: User = {
  id: 'user-1',
  email: 'jane@example.com',
  passwordHash: 'hashed',
  name: 'Jane',
  googleId: null,
  isEmailVerified: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fakeStoredRefreshToken(overrides: Partial<RefreshToken & { user: User }> = {}) {
  return {
    id: 'rt-1',
    tokenHash: 'irrelevant-because-mocked',
    userId: fakeUser.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    revokedAt: null,
    replacedByTokenHash: null,
    createdAt: new Date(),
    user: fakeUser,
    ...overrides,
  };
}

describe('token.service', () => {
  describe('issueTokenPair', () => {
    it('returns a valid access token and persists a hashed refresh token', async () => {
      prismaMock.refreshToken.create.mockResolvedValue(fakeStoredRefreshToken());

      const pair = await issueTokenPair(fakeUser);

      expect(verifyAccessToken(pair.accessToken)).toMatchObject({
        sub: fakeUser.id,
        email: fakeUser.email,
      });
      expect(pair.refreshToken).toHaveLength(96); // 48 random bytes, hex-encoded

      // The raw refresh token must never be written to the DB — only a hash.
      const createArgs = prismaMock.refreshToken.create.mock.calls[0][0];
      expect(createArgs.data.tokenHash).not.toBe(pair.refreshToken);
      expect(createArgs.data.userId).toBe(fakeUser.id);
    });
  });

  describe('rotateRefreshToken', () => {
    it('rejects an unknown refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);
      await expect(rotateRefreshToken('does-not-exist')).rejects.toThrow(AppError);
    });

    it('rejects (and mass-revokes) a token that was already used once, logging the reuse as a security event', async () => {
      const stored = fakeStoredRefreshToken({ revokedAt: new Date() });
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(rotateRefreshToken('reused-token')).rejects.toThrow(
        'Refresh token has already been used',
      );
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: fakeUser.id, revokedAt: null } }),
      );

      // The fix for "token-theft detection is silent": this used to revoke
      // every session with no log, alert, or record anywhere. Now there's a
      // structured log line naming the user and the reason, logged BEFORE
      // the mass-revoke so it can't be lost if that write ever failed.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
      expect(loggedPayload).toMatchObject({
        event: 'refresh_token_reuse_detected',
        userId: fakeUser.id,
        reason: 'already-used',
      });
      consoleErrorSpy.mockRestore();
    });

    it('rejects an expired token', async () => {
      const stored = fakeStoredRefreshToken({ expiresAt: new Date(Date.now() - 1000) });
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);

      await expect(rotateRefreshToken('expired-token')).rejects.toThrow(
        'Refresh token has expired',
      );
    });

    it('rejects rotation for a disabled account, even with an otherwise-valid token', async () => {
      const stored = fakeStoredRefreshToken({ user: { ...fakeUser, isActive: false } });
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);

      await expect(rotateRefreshToken('token-for-disabled-user')).rejects.toThrow(
        'This account is no longer active',
      );
      // Must not have claimed/rotated the token on the way to rejecting it.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rotates a valid token: claims it atomically and issues a new pair', async () => {
      const stored = fakeStoredRefreshToken();
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
      // Interactive transaction — invoke the callback with prismaMock itself
      // standing in for `tx` (it's already a deep mock of every Prisma method).
      prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock));
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 }); // won the claim
      prismaMock.refreshToken.create.mockResolvedValue(fakeStoredRefreshToken());

      const pair = await rotateRefreshToken('valid-raw-token');

      expect(verifyAccessToken(pair.accessToken)).toMatchObject({
        sub: fakeUser.id,
        email: fakeUser.email,
      });
      expect(pair.refreshToken).not.toBe('valid-raw-token');
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: stored.id, revokedAt: null } }),
      );
      expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('closes the rotation race: a lost claim (count 0) is treated as reuse, not a hard error — and still logs it', async () => {
      // Simulates two concurrent rotate calls for the same token: this call's
      // findUnique still sees revokedAt: null (the other caller hasn't
      // committed yet), but by the time its own conditional updateMany runs,
      // the other caller already claimed the row — count comes back 0.
      const stored = fakeStoredRefreshToken();
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
      prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock));
      prismaMock.refreshToken.updateMany
        .mockResolvedValueOnce({ count: 0 }) // lost the claim, inside the transaction
        .mockResolvedValueOnce({ count: 1 }); // the subsequent mass-revoke-for-user call
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(rotateRefreshToken('raced-token')).rejects.toThrow(
        'Refresh token has already been used',
      );
      expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
      // Second updateMany call is the mass revoke, same as the "already
      // revoked" branch — same fallback response to a detected race/replay.
      expect(prismaMock.refreshToken.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { userId: fakeUser.id, revokedAt: null } }),
      );

      const loggedPayload = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
      expect(loggedPayload).toMatchObject({
        event: 'refresh_token_reuse_detected',
        userId: fakeUser.id,
        reason: 'lost-rotation-race',
      });
      consoleErrorSpy.mockRestore();
    });
  });

  describe('revokeRefreshToken', () => {
    it('marks the matching, not-yet-revoked token as revoked', async () => {
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await revokeRefreshToken('some-raw-token');

      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ revokedAt: null }),
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });
  });
});

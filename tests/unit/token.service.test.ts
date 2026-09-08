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

      expect(verifyAccessToken(pair.accessToken)).toEqual({
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

    it('rejects (and mass-revokes) a token that was already used once', async () => {
      const stored = fakeStoredRefreshToken({ revokedAt: new Date() });
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await expect(rotateRefreshToken('reused-token')).rejects.toThrow(
        'Refresh token has already been used',
      );
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: fakeUser.id, revokedAt: null } }),
      );
    });

    it('rejects an expired token', async () => {
      const stored = fakeStoredRefreshToken({ expiresAt: new Date(Date.now() - 1000) });
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);

      await expect(rotateRefreshToken('expired-token')).rejects.toThrow(
        'Refresh token has expired',
      );
    });

    it('rotates a valid token: revokes the old one and issues a new pair', async () => {
      const stored = fakeStoredRefreshToken();
      prismaMock.refreshToken.findUnique.mockResolvedValue(stored);
      prismaMock.$transaction.mockResolvedValue([{}, {}]);

      const pair = await rotateRefreshToken('valid-raw-token');

      expect(verifyAccessToken(pair.accessToken)).toEqual({
        sub: fakeUser.id,
        email: fakeUser.email,
      });
      expect(pair.refreshToken).not.toBe('valid-raw-token');
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
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

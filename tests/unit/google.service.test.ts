import type { User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { findOrCreateGoogleUser } from '../../src/services/google.service';
import { AppError } from '../../src/utils/AppError';

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

const profile = {
  googleId: 'google-sub-123',
  email: 'jane@example.com',
  emailVerified: true,
  name: 'Jane',
};

describe('google.service findOrCreateGoogleUser', () => {
  it('returns the existing user when already linked by googleId, via a single lookup', async () => {
    const existing = buildUser({ googleId: profile.googleId });
    prismaMock.user.findFirst.mockResolvedValue(existing);

    const result = await findOrCreateGoogleUser(profile);

    expect(result).toBe(existing);
    expect(prismaMock.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('links googleId onto a matching-email account when the email is verified', async () => {
    prismaMock.user.findFirst.mockResolvedValue(buildUser({ googleId: null }));
    prismaMock.user.update.mockResolvedValue(
      buildUser({ googleId: profile.googleId, isEmailVerified: true }),
    );

    const result = await findOrCreateGoogleUser(profile);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { googleId: profile.googleId, isEmailVerified: true },
      }),
    );
    expect(result.googleId).toBe(profile.googleId);
  });

  it('refuses to link an existing account when Google has not verified the email', async () => {
    prismaMock.user.findFirst.mockResolvedValue(buildUser({ googleId: null }));

    await expect(
      findOrCreateGoogleUser({ ...profile, emailVerified: false }),
    ).rejects.toMatchObject(new AppError(400, 'Google account email is not verified'));
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('creates a brand-new password-less account when no match exists at all', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(
      buildUser({ googleId: profile.googleId, passwordHash: null }),
    );

    await findOrCreateGoogleUser(profile);

    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: profile.email,
          googleId: profile.googleId,
          passwordHash: null,
        }),
      }),
    );
  });
});

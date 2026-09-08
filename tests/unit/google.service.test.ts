import { Prisma, type User } from '@prisma/client';
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

  it('closes the concurrent-Google-signup race: a P2002 from create() resolves to the winner, not a crash', async () => {
    // Simulates two simultaneous Google logins for the same brand-new
    // account: this call's findFirst still sees no existing user (the other
    // caller hasn't committed yet), so it proceeds to create() — which is
    // where the real `email`/`googleId` unique constraints catch it.
    const winner = buildUser({ googleId: profile.googleId, passwordHash: null });
    prismaMock.user.findFirst
      .mockResolvedValueOnce(null) // initial lookup: no match yet
      .mockResolvedValueOnce(winner); // re-fetch after losing the create() race
    prismaMock.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );

    const result = await findOrCreateGoogleUser(profile);

    expect(result).toBe(winner);
    expect(prismaMock.user.findFirst).toHaveBeenCalledTimes(2);
  });

  it('re-throws an unrelated database error from create() rather than misreporting it as a race', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockRejectedValue(new Error('connection reset'));

    await expect(findOrCreateGoogleUser(profile)).rejects.toThrow('connection reset');
  });
});

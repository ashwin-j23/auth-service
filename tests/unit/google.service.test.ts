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
    failedLoginAttempts: 0,
    lockedUntil: null,
    isActive: true,
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

  it('links googleId onto a matching-email account when both Google AND the existing account have verified the email', async () => {
    prismaMock.user.findFirst.mockResolvedValue(
      buildUser({ googleId: null, isEmailVerified: true }),
    );
    prismaMock.user.update.mockResolvedValue(
      buildUser({ googleId: profile.googleId, isEmailVerified: true }),
    );

    const result = await findOrCreateGoogleUser(profile);

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { googleId: profile.googleId },
      }),
    );
    expect(result.googleId).toBe(profile.googleId);
  });

  // The account-takeover fix (see google.service.ts's comment on this
  // check): Google verifying ITS copy of the email is not proof that the
  // EXISTING local account ever did. auth.service.ts's signup() never
  // required email verification for a password account, so without this
  // check an attacker could sign up first with someone else's (real,
  // Google-account-holding) email address, and that victim's later,
  // genuinely Google-verified sign-in would silently link onto — and leave
  // standing password access on — the attacker's account.
  it('refuses to link when the EXISTING account has never verified its own email, even though Google verified its copy', async () => {
    prismaMock.user.findFirst.mockResolvedValue(
      buildUser({ googleId: null, isEmailVerified: false }),
    );

    await expect(findOrCreateGoogleUser(profile)).rejects.toMatchObject(
      new AppError(
        409,
        'An account with this email already exists but has not verified ownership of it. ' +
          'Verify your email or reset your password first, then sign in with Google again.',
      ),
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('closes the concurrent-link race: a P2002 from update() resolves to the already-linked row', async () => {
    // Simulates two simultaneous Google logins for the same account being
    // linked for the first time: this call's findFirst still sees
    // googleId: null (the other caller hasn't committed yet), so it
    // proceeds to update() — which is where the real `googleId` unique
    // constraint catches it, because the other caller's update already won.
    const existing = buildUser({ googleId: null, isEmailVerified: true });
    const winner = buildUser({ ...existing, googleId: profile.googleId });
    prismaMock.user.findFirst.mockResolvedValueOnce(existing);
    prismaMock.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`googleId`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    prismaMock.user.findUnique.mockResolvedValue(winner); // re-fetch by googleId

    const result = await findOrCreateGoogleUser(profile);

    expect(result).toBe(winner);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { googleId: profile.googleId },
    });
  });

  it('does NOT silently hand back a different account when the P2002 is a genuine conflict, not a race', async () => {
    // This googleId is already claimed, but by a DIFFERENT user entirely —
    // re-fetching by googleId finds someone whose email doesn't match the
    // row we were trying to link. That's a real conflict, not two callers
    // racing to link the same account, and must not be silently papered over.
    const existing = buildUser({
      id: 'user-1',
      email: 'jane@example.com',
      googleId: null,
      isEmailVerified: true,
    });
    const someoneElse = buildUser({
      id: 'user-2',
      email: 'someone-else@example.com',
      googleId: profile.googleId,
    });
    prismaMock.user.findFirst.mockResolvedValueOnce(existing);
    prismaMock.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`googleId`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    prismaMock.user.findUnique.mockResolvedValue(someoneElse);

    await expect(findOrCreateGoogleUser(profile)).rejects.toMatchObject(
      new AppError(409, 'This Google account is already linked to a different user'),
    );
  });

  it('refuses to link an existing account when Google has not verified the email, even if the existing account has', async () => {
    prismaMock.user.findFirst.mockResolvedValue(
      buildUser({ googleId: null, isEmailVerified: true }),
    );

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

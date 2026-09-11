import request from 'supertest';
import { Prisma, VerificationPurpose, type User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { createApp } from '../../src/app';
import { createHandoff } from '../../src/services/oauthHandoff.service';
import { toPublicUser } from '../../src/utils/publicUser';
import { signAccessToken } from '../../src/utils/jwt';
import { env } from '../../src/config/env';

// Real email sending (mail.service.ts) hits the network (Ethereal) — every
// route below that can trigger an email (signup, /email/verify,
// /password/reset) must never actually attempt that in a test.
jest.mock('../../src/services/mail.service', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

const app = createApp();

// confirmEmailVerification/confirmPasswordReset (auth.service.ts) both run
// inside `prisma.$transaction(async (tx) => {...})` — an unconfigured mock
// of `$transaction` never actually invokes that callback, silently
// skipping every write inside it. `tx` ends up being `prismaMock` itself.
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

describe('POST /api/auth/signup', () => {
  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/email/i);
  });

  it('rejects a too-short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'short' });

    expect(res.status).toBe(400);
  });

  it('returns 201 with a user and tokens on valid input', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockImplementation((async ({ data }: any) => buildUser({
      email: data.email,
      passwordHash: data.passwordHash,
    })) as any);
    prismaMock.refreshToken.create.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('jane@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(typeof res.body.tokens.accessToken).toBe('string');
  });

  it('returns 409 when the email is already registered', async () => {
    prismaMock.user.findUnique.mockResolvedValue(buildUser());

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'password123' });

    expect(res.status).toBe(409);
  });

  it('returns 409 (not 500) when the race is only caught by the DB unique constraint', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null); // fast-path check misses the race
    prismaMock.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'password123' });

    expect(res.status).toBe(409);
  });

  it('rejects a password over 72 characters with 400', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'a'.repeat(73) });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 401 for a nonexistent account', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a disabled account, even with an otherwise-valid token', async () => {
    const user = buildUser({ isActive: false });
    const token = signAccessToken({ sub: user.id, email: user.email });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 200 for an active account', async () => {
    const user = buildUser({ isActive: true });
    const token = signAccessToken({ sub: user.id, email: user.email });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });
});

describe('GET /api/auth/google', () => {
  it('redirects to Google with a state param and sets a state cookie', async () => {
    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
    expect(res.headers['set-cookie']?.[0]).toMatch(/oauth_state=/);
  });

  it('is rate-limited (standard budget)', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('GET /api/auth/google/callback', () => {
  it('is rate-limited (standard budget)', async () => {
    const res = await request(app).get('/api/auth/google/callback');
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('clears the state cookie with attributes matching how it was set, on a rejected callback', async () => {
    const res = await request(app).get('/api/auth/google/callback?code=abc&state=wrong');

    expect(res.status).toBe(400);
    const setCookieHeaders = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const clearCookieHeader = setCookieHeaders.find((c) => c.startsWith('oauth_state='));
    expect(clearCookieHeader).toBeDefined();
    // Matches googleRedirect's res.cookie(...) attributes — a mismatched
    // clearCookie() call (e.g. missing HttpOnly/SameSite) can leave the
    // original cookie in place instead of actually clearing it.
    expect(clearCookieHeader).toMatch(/HttpOnly/i);
    expect(clearCookieHeader).toMatch(/SameSite=Lax/i);
  });

  // The UX fix: Google redirects here with `?error=access_denied` (no
  // `code`) when the user clicks "Cancel" on the consent screen — this used
  // to fall through to a raw "Missing authorization code" 400 instead of
  // sending the browser back to the frontend.
  it('redirects back to the frontend with an error indicator when the user denies consent, instead of a raw 400', async () => {
    const res = await request(app).get(
      '/api/auth/google/callback?error=access_denied&state=whatever',
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(env.OAUTH_SUCCESS_REDIRECT_URL);
    expect(location.searchParams.get('error')).toBe('google_consent_denied');
  });

  // Narrower than "any truthy `error` param": a real provider-side failure
  // (not the user declining consent) must NOT be mislabeled as
  // google_consent_denied — it falls through to the existing "missing
  // authorization code" handling instead, the same as before consent
  // denial had its own branch at all.
  it('does NOT treat a non-consent OAuth error (e.g. a provider failure) as consent denial', async () => {
    const res = await request(app).get(
      '/api/auth/google/callback?error=temporarily_unavailable&state=whatever',
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/missing authorization code/i);
  });
});

describe('POST /api/auth/google/exchange', () => {
  it('rejects an unknown code with 400', async () => {
    const res = await request(app)
      .post('/api/auth/google/exchange')
      .send({ code: 'not-a-real-handoff-code' });

    expect(res.status).toBe(400);
  });

  it('exchanges a valid handoff code exactly once', async () => {
    const user = toPublicUser(buildUser({ email: 'oauth-user@example.com' }));
    const tokens = { accessToken: 'atk', refreshToken: 'rtk' };
    const code = createHandoff(user, tokens);

    const first = await request(app).post('/api/auth/google/exchange').send({ code });
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe('oauth-user@example.com');
    expect(first.body.tokens).toEqual(tokens);

    // Single-use: the same code can't be exchanged twice.
    const second = await request(app).post('/api/auth/google/exchange').send({ code });
    expect(second.status).toBe(400);
  });
});

describe('POST /api/auth/email/verify', () => {
  it('returns the same generic message whether or not the account exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const forNonexistent = await request(app)
      .post('/api/auth/email/verify')
      .send({ email: 'nobody@example.com' });

    prismaMock.user.findUnique.mockResolvedValue(buildUser({ isEmailVerified: false }));
    const forExisting = await request(app)
      .post('/api/auth/email/verify')
      .send({ email: 'jane@example.com' });

    expect(forNonexistent.status).toBe(200);
    expect(forExisting.status).toBe(200);
    expect(forNonexistent.body).toEqual(forExisting.body);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app).post('/api/auth/email/verify').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/email/verify/confirm', () => {
  it('rejects an invalid/unknown token with 400', async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/email/verify/confirm')
      .send({ token: 'not-a-real-token' });

    expect(res.status).toBe(400);
  });

  it('marks the account verified for a valid token', async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: 'vt-1',
      tokenHash: 'irrelevant',
      userId: 'user-1',
      purpose: VerificationPurpose.EMAIL_VERIFICATION,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    } as any);
    prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue(buildUser({ isEmailVerified: true }));

    const res = await request(app)
      .post('/api/auth/email/verify/confirm')
      .send({ token: 'a-valid-raw-token' });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isEmailVerified: true },
    });
  });
});

describe('POST /api/auth/password/reset', () => {
  it('returns 200 with a generic message whether or not the account exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
  });
});

describe('POST /api/auth/password/reset/confirm', () => {
  it('rejects an invalid/unknown token with 400', async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/password/reset/confirm')
      .send({ token: 'not-a-real-token', password: 'brand-new-password' });

    expect(res.status).toBe(400);
  });

  it('sets a new password and revokes existing sessions for a valid token', async () => {
    prismaMock.verificationToken.findUnique.mockResolvedValue({
      id: 'vt-1',
      tokenHash: 'irrelevant',
      userId: 'user-1',
      purpose: VerificationPurpose.PASSWORD_RESET,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    } as any);
    prismaMock.verificationToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue(buildUser());
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .post('/api/auth/password/reset/confirm')
      .send({ token: 'a-valid-raw-token', password: 'brand-new-password' });

    expect(res.status).toBe(200);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
  });

  it('rejects a too-short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/password/reset/confirm')
      .send({ token: 'whatever', password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('request body edge cases', () => {
  it('rejects a body over JSON_BODY_LIMIT with 413, not a generic 500', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'jane@example.com', password: 'password123', name: 'x'.repeat(20_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBeTruthy();
  });

  it('rejects malformed JSON with 400, not a generic 500', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
  });
});

describe('hardened response headers', () => {
  it('sets Cache-Control: no-store and a restrictive Permissions-Policy on every response', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['permissions-policy']).toContain('microphone=()');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
  });
});

describe('unknown route', () => {
  it('returns a 404 JSON error', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/route not found/i);
  });
});

import request from 'supertest';
import { Prisma, type User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { createApp } from '../../src/app';
import { createHandoff } from '../../src/services/oauthHandoff.service';
import { toPublicUser } from '../../src/utils/publicUser';

const app = createApp();

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
});

describe('GET /api/auth/google', () => {
  it('redirects to Google with a state param and sets a state cookie', async () => {
    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
    expect(res.headers['set-cookie']?.[0]).toMatch(/oauth_state=/);
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

describe('unknown route', () => {
  it('returns a 404 JSON error', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/route not found/i);
  });
});

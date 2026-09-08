import request from 'supertest';
import type { User } from '@prisma/client';
import { prismaMock } from '../mocks/prisma.mock';
import { createApp } from '../../src/app';

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

describe('unknown route', () => {
  it('returns a 404 JSON error', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/route not found/i);
  });
});

import request from 'supertest';
import { prismaMock } from '../mocks/prisma.mock';
import { createApp } from '../../src/app';

// A dedicated file (not folded into auth.routes.test.ts) specifically so
// this gets its own fresh module registry — strictAuthRateLimiter and
// standardAuthRateLimiter (rateLimit.middleware.ts) are created once at
// import time and keep their counters for the life of that import, so
// sharing a file with other route tests would mean their earlier requests
// silently ate into the budget this test relies on being empty.
const app = createApp();

describe('rate limiting: strict vs standard budgets are independent', () => {
  it('exhausting the strict (signup/login) budget does not affect the standard (refresh/logout) budget', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    // RATE_LIMIT_STRICT_MAX defaults to 30 — drive one past it.
    let lastLoginStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong' });
      lastLoginStatus = res.status;
    }
    expect(lastLoginStatus).toBe(429); // strict budget is now exhausted

    // /refresh runs on the SEPARATE standard limiter — this is the actual
    // regression check: an earlier version reused one limiter instance
    // across every auth route, so this request would also have come back
    // 429 purely from the login burst above, despite never touching
    // /refresh before now.
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'irrelevant-invalid-token' });

    // 401 (invalid refresh token) — not 429 — proves the request reached the
    // real route logic instead of being blocked by login's exhausted budget.
    expect(refreshRes.status).toBe(401);
  }, 20_000);
});

// Runs once before the test framework is installed (see jest.config.js
// `setupFiles`) — seeds every env var src/config/env.ts requires so it
// parses successfully no matter which test file imports it first.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db?schema=public';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret-please-ignore';
process.env.JWT_ACCESS_TTL = '15m';
process.env.REFRESH_TOKEN_TTL_DAYS = '7';
process.env.COOKIE_SECRET = 'test-cookie-secret-please-ignore';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/auth/google/callback';
process.env.OAUTH_SUCCESS_REDIRECT_URL = 'http://localhost:3000/oauth/callback';

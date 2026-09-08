/**
 * env.ts parses `process.env` once, at import time, into the `env` object
 * every other file imports — so proving "this exact process.env produces
 * this exact behavior" means starting from a genuinely fresh module
 * registry per case, not just reassigning process.env after env.ts has
 * already run once and cached its answer. Shared by every test that needs
 * to exercise env.ts's parsing/validation directly.
 */

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://x/y',
  JWT_ACCESS_SECRET: 'x'.repeat(20),
  COOKIE_SECRET: 'x'.repeat(20),
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/auth/google/callback',
  OAUTH_SUCCESS_REDIRECT_URL: 'http://localhost:3000/oauth/callback',
};

export function withFreshEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const savedEnv = { ...process.env };
  Object.assign(process.env, REQUIRED_ENV, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }

  let result!: T;
  jest.isolateModules(() => {
    result = run();
  });

  process.env = savedEnv;
  return result;
}

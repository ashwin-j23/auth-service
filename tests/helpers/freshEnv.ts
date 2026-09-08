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
  try {
    Object.assign(process.env, REQUIRED_ENV, overrides);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
    }

    let result!: T;
    jest.isolateModules(() => {
      result = run();
    });
    return result;
  } finally {
    // A `finally`, not a plain statement after the call above — this is the
    // whole point of this helper's existence, and a `run()` that's expected
    // to throw (every "rejects a bad value" test in this suite calls
    // `withFreshEnv` precisely to assert that) is the exact case a bare
    // post-call statement would skip: the exception would unwind straight
    // out of this function, past the restore, leaving process.env
    // permanently polluted with this call's overrides for every test that
    // runs afterward in the same file. That's not hypothetical — it's
    // exactly what happened before this was a `finally`: a "rejects ..."
    // test elsewhere in a file would leak its bad env value forward, and an
    // unrelated *later* test's own `withFreshEnv` call — itself entirely
    // correct — would still fail, parsing against an already-corrupted
    // process.env its own overrides never fully overwrote (Object.assign
    // only touches the keys actually present in that call's overrides, not
    // stray leftovers from a previous one).
    process.env = savedEnv;
  }
}

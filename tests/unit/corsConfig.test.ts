import { withFreshEnv } from '../helpers/freshEnv';

describe('ALLOW_ANY_CORS_ORIGIN parsing (env.ts)', () => {
  it('"false" parses to boolean false, not true', () => {
    const { env } = withFreshEnv({ ALLOW_ANY_CORS_ORIGIN: 'false' }, () =>
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../src/config/env'),
    );
    // The bug this guards against: z.coerce.boolean() uses JS's Boolean(),
    // under which Boolean("false") === true — any non-empty string is
    // truthy. If ALLOW_ANY_CORS_ORIGIN ever regressed to that, this
    // assertion (not just a `toBeFalsy()`) would catch it.
    expect(env.ALLOW_ANY_CORS_ORIGIN).toBe(false);
  });

  it('"true" parses to boolean true', () => {
    const { env } = withFreshEnv({ ALLOW_ANY_CORS_ORIGIN: 'true' }, () =>
      require('../../src/config/env'),
    );
    expect(env.ALLOW_ANY_CORS_ORIGIN).toBe(true);
  });

  it('unset defaults to false', () => {
    const { env } = withFreshEnv({ ALLOW_ANY_CORS_ORIGIN: undefined }, () =>
      require('../../src/config/env'),
    );
    expect(env.ALLOW_ANY_CORS_ORIGIN).toBe(false);
  });

  it('rejects a nonsense value instead of silently defaulting', () => {
    expect(() =>
      withFreshEnv({ ALLOW_ANY_CORS_ORIGIN: 'yes-please' }, () => require('../../src/config/env')),
    ).toThrow();
  });
});

describe('CORS defaults closed regardless of NODE_ENV (app.ts corsOrigin)', () => {
  it('stays closed with NODE_ENV entirely unset and no CORS config at all', async () => {
    const { createApp } = withFreshEnv(
      { NODE_ENV: undefined, CORS_ALLOWED_ORIGINS: undefined, ALLOW_ANY_CORS_ORIGIN: undefined },
      () => require('../../src/app'),
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest');
    const app = createApp();

    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://random-site.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('opens up when ALLOW_ANY_CORS_ORIGIN=true is explicitly set', async () => {
    const { createApp } = withFreshEnv(
      { NODE_ENV: undefined, CORS_ALLOWED_ORIGINS: undefined, ALLOW_ANY_CORS_ORIGIN: 'true' },
      () => require('../../src/app'),
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest');
    const app = createApp();

    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://random-site.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBe('http://random-site.example');
  });
});

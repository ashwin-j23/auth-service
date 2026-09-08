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

describe('CORS_ALLOWED_ORIGINS parsing/validation (env.ts)', () => {
  it('a single valid origin parses to a one-element array', () => {
    const { env } = withFreshEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com' }, () =>
      require('../../src/config/env'),
    );
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://app.example.com']);
  });

  it('multiple comma-separated origins are trimmed and parsed', () => {
    const { env } = withFreshEnv(
      { CORS_ALLOWED_ORIGINS: ' https://a.example.com , http://localhost:3000 ' },
      () => require('../../src/config/env'),
    );
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'http://localhost:3000']);
  });

  it('unset stays undefined (falls through to ALLOW_ANY_CORS_ORIGIN)', () => {
    const { env } = withFreshEnv({ CORS_ALLOWED_ORIGINS: undefined }, () =>
      require('../../src/config/env'),
    );
    expect(env.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it.each(['', ',', ' , , ', ' '])(
    'rejects an empty/comma-only value instead of silently producing empty-string origins: %j',
    (value) => {
      // Without this check, `value.split(',')` on any of these produces one
      // or more empty-string entries — a broken allowlist that would never
      // match a real browser Origin header, with no error telling the
      // operator their config typo means "nothing will ever be allowed."
      expect(() =>
        withFreshEnv({ CORS_ALLOWED_ORIGINS: value }, () => require('../../src/config/env')),
      ).toThrow();
    },
  );

  it('rejects an origin with a trailing slash', () => {
    // A real Origin header never has a path or trailing slash — this shape
    // is always a config mistake, not a real production origin.
    expect(() =>
      withFreshEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com/' }, () =>
        require('../../src/config/env'),
      ),
    ).toThrow();
  });

  it('rejects an origin with a path', () => {
    expect(() =>
      withFreshEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com/callback' }, () =>
        require('../../src/config/env'),
      ),
    ).toThrow();
  });

  it('rejects an origin missing a scheme', () => {
    expect(() =>
      withFreshEnv({ CORS_ALLOWED_ORIGINS: 'app.example.com' }, () =>
        require('../../src/config/env'),
      ),
    ).toThrow();
  });

  it('rejects the whole value if even one origin in a comma-separated list is malformed', () => {
    expect(() =>
      withFreshEnv(
        { CORS_ALLOWED_ORIGINS: 'https://good.example.com,not-a-valid-origin' },
        () => require('../../src/config/env'),
      ),
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

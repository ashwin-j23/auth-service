import { withFreshEnv } from '../helpers/freshEnv';

describe('JWT_ACCESS_TTL validation (env.ts)', () => {
  it('accepts a normal value', () => {
    const { env } = withFreshEnv({ JWT_ACCESS_TTL: '15m' }, () => require('../../src/config/env'));
    expect(env.JWT_ACCESS_TTL).toBe('15m');
  });

  it.each(['0', '0s', '0m', '0.0h', '0d'])(
    'rejects a zero-second/zero-duration TTL: %s',
    (value) => {
      // The format regex alone accepts "0" just as validly as "15m" — a
      // token with a zero-length lifetime isn't a shape problem, it's a
      // value problem, and would mean every token is born already expired.
      // This must fail at envSchema.parse() (boot time), not surface later
      // as "every single request is unauthorized" in production.
      expect(() =>
        withFreshEnv({ JWT_ACCESS_TTL: value }, () => require('../../src/config/env')),
      ).toThrow();
    },
  );

  it('still rejects a value with a bad format entirely, same as before', () => {
    expect(() =>
      withFreshEnv({ JWT_ACCESS_TTL: 'banana' }, () => require('../../src/config/env')),
    ).toThrow();
  });

  it('accepts a fractional value that rounds to a nonzero duration', () => {
    const { env } = withFreshEnv({ JWT_ACCESS_TTL: '0.5h' }, () =>
      require('../../src/config/env'),
    );
    expect(env.JWT_ACCESS_TTL).toBe('0.5h');
  });
});

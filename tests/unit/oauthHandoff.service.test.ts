import { createHandoff, consumeHandoff } from '../../src/services/oauthHandoff.service';
import type { PublicUser } from '../../src/utils/publicUser';
import { withFreshEnv } from '../helpers/freshEnv';

const user: PublicUser = {
  id: 'user-1',
  email: 'jane@example.com',
  name: 'Jane',
  isEmailVerified: true,
  createdAt: new Date(),
};
const tokens = { accessToken: 'atk', refreshToken: 'rtk' };

describe('oauthHandoff.service', () => {
  it('round-trips a stashed user/tokens pair through its code', () => {
    const code = createHandoff(user, tokens);
    const result = consumeHandoff(code);
    expect(result).toEqual({ user, tokens });
  });

  it('is single-use: a second consume of the same code returns undefined', () => {
    const code = createHandoff(user, tokens);
    consumeHandoff(code);
    expect(consumeHandoff(code)).toBeUndefined();
  });

  it('returns undefined for a code that was never issued', () => {
    expect(consumeHandoff('never-issued-code')).toBeUndefined();
  });

  it('rejects an expired code even though it was only consumed once', () => {
    jest.useFakeTimers();
    try {
      const code = createHandoff(user, tokens);
      jest.advanceTimersByTime(61 * 1000); // past the 60s TTL
      expect(consumeHandoff(code)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('generates a different code each time', () => {
    const codeA = createHandoff(user, tokens);
    const codeB = createHandoff(user, tokens);
    expect(codeA).not.toBe(codeB);
  });

  it('respects OAUTH_HANDOFF_MAX_ENTRIES: evicts the oldest unconsumed entry once the cap is hit, and warns', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withFreshEnv({ OAUTH_HANDOFF_MAX_ENTRIES: '3' }, () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fresh = require('../../src/services/oauthHandoff.service');
        const codes = [1, 2, 3].map(() => fresh.createHandoff(user, tokens));
        expect(warnSpy).not.toHaveBeenCalled(); // exactly at the cap, not over it yet

        const fourthCode = fresh.createHandoff(user, tokens); // pushes it over -> eviction

        expect(warnSpy).toHaveBeenCalledTimes(1);
        // The oldest (first-created) code is gone...
        expect(fresh.consumeHandoff(codes[0])).toBeUndefined();
        // ...but the newer ones, including the one that triggered eviction,
        // are still perfectly valid.
        expect(fresh.consumeHandoff(codes[2])).toEqual({ user, tokens });
        expect(fresh.consumeHandoff(fourthCode)).toEqual({ user, tokens });
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

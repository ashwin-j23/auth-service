import { createHandoff, consumeHandoff } from '../../src/services/oauthHandoff.service';
import type { PublicUser } from '../../src/utils/publicUser';
import { withFreshEnv } from '../helpers/freshEnv';
import { AppError } from '../../src/utils/AppError';

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

  it('respects OAUTH_HANDOFF_MAX_ENTRIES: rejects a NEW handoff once the cap is hit, without touching existing ones', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      withFreshEnv({ OAUTH_HANDOFF_MAX_ENTRIES: '3' }, () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fresh = require('../../src/services/oauthHandoff.service');
        const codes = [1, 2, 3].map(() => fresh.createHandoff(user, tokens));
        expect(errorSpy).not.toHaveBeenCalled(); // exactly at the cap, not over it yet

        // The 4th call is the one that's actually causing the overload —
        // that's the one that fails, as a retryable 503, NOT an eviction of
        // someone else's already-issued, still-valid code.
        expect(() => fresh.createHandoff(user, tokens)).toThrow(
          new AppError(503, 'Too many sign-ins in progress right now — please try again'),
        );
        expect(errorSpy).toHaveBeenCalledTimes(1);

        // All three original codes remain perfectly valid — none of them
        // were touched by the rejected 4th attempt.
        for (const code of codes) {
          expect(fresh.consumeHandoff(code)).toEqual({ user, tokens });
        }
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

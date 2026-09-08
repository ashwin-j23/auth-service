import { createHandoff, consumeHandoff } from '../../src/services/oauthHandoff.service';
import type { PublicUser } from '../../src/utils/publicUser';

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
});

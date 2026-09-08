import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from '../../src/utils/jwt';

describe('jwt utils', () => {
  const payload = { sub: 'user-123', email: 'jane@example.com' };

  it('signs a token that verifies back to the same payload', () => {
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded).toEqual(payload);
  });

  it('throws on a token signed with a different secret', () => {
    const badToken = jwt.sign(payload, 'some-other-secret');
    expect(() => verifyAccessToken(badToken)).toThrow(jwt.JsonWebTokenError);
  });

  it('throws on an expired token', () => {
    const expiredToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, {
      expiresIn: -10, // already expired
    });
    expect(() => verifyAccessToken(expiredToken)).toThrow(jwt.TokenExpiredError);
  });

  it('throws on a token missing required claims', () => {
    const incompleteToken = jwt.sign(
      { sub: 'user-123' }, // no email
      process.env.JWT_ACCESS_SECRET as string,
    );
    expect(() => verifyAccessToken(incompleteToken)).toThrow(jwt.JsonWebTokenError);
  });
});

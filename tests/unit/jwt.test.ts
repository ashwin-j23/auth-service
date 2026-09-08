import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from '../../src/utils/jwt';

describe('jwt utils', () => {
  const payload = { sub: 'user-123', email: 'jane@example.com' };

  it('signs a token that verifies back to the same payload, plus a jti', () => {
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded).toMatchObject(payload);
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBeGreaterThan(0);
  });

  it('gives two separately-signed tokens for the same user different jti values', () => {
    // jti identifies a specific TOKEN, not the user — groundwork for a
    // future per-token revocation list (see the comment in jwt.ts).
    const tokenA = signAccessToken(payload);
    const tokenB = signAccessToken(payload);
    expect(verifyAccessToken(tokenA).jti).not.toBe(verifyAccessToken(tokenB).jti);
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

  it('throws on a correctly-signed token issued for a different audience', () => {
    // Same secret, same payload shape — the only thing wrong is `aud`.
    // Confirms verifyAccessToken actually enforces JWT_AUDIENCE rather than
    // just tolerating whatever value (or none) shows up.
    const wrongAudienceToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, {
      issuer: process.env.JWT_ISSUER || 'auth-service',
      audience: 'some-other-app',
    });
    expect(() => verifyAccessToken(wrongAudienceToken)).toThrow(jwt.JsonWebTokenError);
  });

  it('throws on a correctly-signed token issued by a different issuer', () => {
    const wrongIssuerToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, {
      issuer: 'some-other-service',
      audience: process.env.JWT_AUDIENCE || 'auth-service',
    });
    expect(() => verifyAccessToken(wrongIssuerToken)).toThrow(jwt.JsonWebTokenError);
  });
});

import type { NextFunction, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../../src/middleware/auth.middleware';
import { signAccessToken } from '../../src/utils/jwt';
import { AppError } from '../../src/utils/AppError';

function mockReqRes(authorizationHeader?: string) {
  const req = { headers: { authorization: authorizationHeader } } as AuthenticatedRequest;
  const res = {} as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next: next as jest.Mock };
}

describe('requireAuth middleware', () => {
  it('rejects a request with no Authorization header', () => {
    const { req, res, next } = mockReqRes(undefined);
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(401);
  });

  it('rejects a header that is not a Bearer token', () => {
    const { req, res, next } = mockReqRes('Basic somebase64');
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('rejects an invalid/garbage token', () => {
    const { req, res, next } = mockReqRes('Bearer not-a-real-token');
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('attaches req.user and calls next() with no error for a valid token', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'jane@example.com' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no arguments = success
    expect(req.user).toEqual({ id: 'user-1', email: 'jane@example.com' });
  });
});

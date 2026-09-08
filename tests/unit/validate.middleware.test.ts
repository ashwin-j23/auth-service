import { z } from 'zod';
import type { Request, Response } from 'express';
import { validate } from '../../src/middleware/validate.middleware';
import { AppError } from '../../src/utils/AppError';

function mockReqRes(overrides: Partial<Request> = {}) {
  const req = { body: {}, query: {}, params: {}, ...overrides } as Request;
  const res = {} as Response;
  const next = jest.fn() as jest.Mock;
  return { req, res, next };
}

describe('validate middleware', () => {
  it('rejects an invalid body with a 400 AppError and does not call the route handler', () => {
    const schema = z.object({ body: z.object({ email: z.string().email() }) });
    const { req, res, next } = mockReqRes({ body: { email: 'not-an-email' } });

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
  });

  it('replaces req.body with the parsed/transformed value on success', () => {
    const schema = z.object({ body: z.object({ email: z.string().trim().toLowerCase() }) });
    const { req, res, next } = mockReqRes({ body: { email: '  Jane@Example.com  ' } });

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.body).toEqual({ email: 'jane@example.com' });
  });

  it('also writes back a parsed/transformed req.query when the schema validates query', () => {
    const schema = z.object({
      body: z.object({}),
      query: z.object({ page: z.coerce.number().int().positive() }),
    });
    const { req, res, next } = mockReqRes({ body: {}, query: { page: '3' } as any });

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ page: 3 });
  });

  it('leaves req.query untouched when the schema does not define a query shape', () => {
    const schema = z.object({ body: z.object({}) });
    const originalQuery = { untouched: 'yes' };
    const { req, res, next } = mockReqRes({ body: {}, query: originalQuery as any });

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.query).toBe(originalQuery);
  });
});

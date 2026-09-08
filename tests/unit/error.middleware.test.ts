import type { Request, Response } from 'express';
import { errorHandler } from '../../src/middleware/error.middleware';
import { AppError } from '../../src/utils/AppError';

function mockRes() {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  it('uses AppError.statusCode and message as-is', () => {
    const res = mockRes();
    errorHandler(new AppError(409, 'conflict'), {} as Request, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'conflict' } });
  });

  it('translates an http-errors-style "exposed" 4xx error (e.g. body-parser) to its real status', () => {
    // Same shape body-parser actually throws for an oversized/malformed
    // body: a plain Error with .statusCode/.status + .expose === true,
    // not an AppError.
    const bodyParserStyleError = Object.assign(new Error('request entity too large'), {
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

    const res = mockRes();
    errorHandler(bodyParserStyleError, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'request entity too large' } });
  });

  it('falls back to a generic 500 for a 4xx-shaped error that is NOT marked exposed', () => {
    // expose: false (or absent) is http-errors' own "don't show this to the
    // client" signal — this must NOT be treated the same as a real AppError.
    const unexposedError = Object.assign(new Error('some internal detail'), {
      statusCode: 400,
      expose: false,
    });

    const res = mockRes();
    errorHandler(unexposedError, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Internal server error' } });
  });

  it('falls back to a generic 500 for a plain unexpected error, without leaking its message', () => {
    const res = mockRes();
    errorHandler(new Error('raw database connection string leaked here'), {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Internal server error' } });
  });

  it('falls back to a generic 500 for a thrown non-Error value', () => {
    const res = mockRes();
    errorHandler('just a string', {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

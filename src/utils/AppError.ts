// A known, expected error (bad input, wrong credentials, conflict, etc.)
// that should be surfaced to the client with a specific status code and
// message, as opposed to an unexpected bug that should be logged and
// answered with a generic 500. See src/middleware/error.middleware.ts.
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational = true;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

import rateLimit from 'express-rate-limit';

// Blunt but effective brute-force/credential-stuffing mitigation on the
// password-based endpoints. Per-IP, so it's not a substitute for per-account
// lockout/backoff in a production system, but a solid baseline.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

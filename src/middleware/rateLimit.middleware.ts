import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

function makeLimiter(max: number) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many attempts, please try again later' } },
  });
}

// Two SEPARATE limiter instances, each with its own counter store — not one
// shared instance attached to every route. express-rate-limit's store lives
// inside the middleware function itself, so reusing one instance across
// multiple routes means those routes all draw down the *same* budget per
// client: a burst of signups could exhaust the count and lock a different
// user out of login, even though they never made a login attempt themselves.
//
// `strictAuthRateLimiter` — signup/login, the actual brute-force /
// credential-stuffing surface — gets its own budget.
// `standardAuthRateLimiter` — refresh/logout/google-exchange — still worth
// bounding (each one touches the database), but shouldn't compete with
// login's budget, and realistically tolerates more legitimate traffic (a
// client refreshing its access token every 15 minutes over a long session,
// for instance).
export const strictAuthRateLimiter = makeLimiter(env.RATE_LIMIT_STRICT_MAX);
export const standardAuthRateLimiter = makeLimiter(env.RATE_LIMIT_STANDARD_MAX);

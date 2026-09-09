import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

// express-rate-limit's default store (used here — no `store` option passed)
// is in-memory and per-process, the same scope as oauthHandoff.service.ts's
// handoff store (see that file's comment). Fine for this project's stated
// single-instance scope, but worth calling out in the same place: running
// more than one instance behind a load balancer gives each instance its own
// counters, which effectively multiplies every limit here by instance count
// rather than enforcing one shared budget per client. A horizontally-scaled
// deployment needs a shared store instead (e.g. `rate-limit-redis`).
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

// A THIRD separate instance, for the exact same reason the two above are
// separate from each other: `/email/verify` and `/password/reset` (the
// "request" endpoints — auth.routes.ts) are, like signup/login, driven by a
// caller-supplied email address rather than a token, so they deserve the
// same tight, per-IP budget — but reusing `strictAuthRateLimiter`'s own
// instance would mean sharing its counter, and a burst of password-reset
// requests could then exhaust the same budget login needs and lock a
// different, innocent user out of signing in. Same numeric cap
// (`RATE_LIMIT_STRICT_MAX`) as strict, but its own independent count.
export const emailRateLimiter = makeLimiter(env.RATE_LIMIT_STRICT_MAX);

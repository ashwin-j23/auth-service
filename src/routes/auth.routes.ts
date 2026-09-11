import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import {
  strictAuthRateLimiter,
  standardAuthRateLimiter,
  emailRateLimiter,
} from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  googleExchangeSchema,
  requestEmailVerificationSchema,
  confirmEmailVerificationSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
} from '../validators/auth.validators';

export const authRouter = Router();

authRouter.post('/signup', strictAuthRateLimiter, validate(signupSchema), authController.signup);
authRouter.post('/login', strictAuthRateLimiter, validate(loginSchema), authController.login);
authRouter.post(
  '/refresh',
  standardAuthRateLimiter,
  validate(refreshSchema),
  authController.refresh,
);
authRouter.post(
  '/logout',
  standardAuthRateLimiter,
  validate(refreshSchema),
  authController.logout,
);
authRouter.get('/me', requireAuth, authController.me);

// standardAuthRateLimiter, not strict — these are driven by a browser
// following redirects (Google's, then this app's own), not something a
// client calls repeatedly in a tight loop under normal use, but neither
// route did any bounding at all before this: /google is cheap (just issues
// a cookie + redirect) but still worth a basic backstop, and /google/callback
// does real work per call — a Google token exchange, an ID-token
// verification, a database read/write — none of which should be reachable
// at unlimited volume just because it's a GET route.
authRouter.get('/google', standardAuthRateLimiter, authController.googleRedirect);
authRouter.get('/google/callback', standardAuthRateLimiter, authController.googleCallback);
authRouter.post(
  '/google/exchange',
  standardAuthRateLimiter,
  validate(googleExchangeSchema),
  authController.googleExchange,
);

// "request" endpoints (send an email keyed off an address the caller just
// typed in) get their own tight budget (emailRateLimiter — see
// rateLimit.middleware.ts for why this is a THIRD instance, not a reuse of
// strictAuthRateLimiter): an unauthenticated, email-address-driven endpoint
// is exactly the kind of thing that can be hammered (mailbox-bombing a
// victim, or probing which addresses have accounts) if it isn't bounded
// tightly. "confirm" endpoints take a specific, high-entropy, single-use
// token instead of a guessable email address — the standard budget (same as
// refresh/logout) is enough.
authRouter.post(
  '/email/verify',
  emailRateLimiter,
  validate(requestEmailVerificationSchema),
  authController.requestEmailVerification,
);
authRouter.post(
  '/email/verify/confirm',
  standardAuthRateLimiter,
  validate(confirmEmailVerificationSchema),
  authController.confirmEmailVerification,
);
authRouter.post(
  '/password/reset',
  emailRateLimiter,
  validate(requestPasswordResetSchema),
  authController.requestPasswordReset,
);
authRouter.post(
  '/password/reset/confirm',
  standardAuthRateLimiter,
  validate(confirmPasswordResetSchema),
  authController.confirmPasswordReset,
);

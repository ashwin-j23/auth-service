import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { strictAuthRateLimiter, standardAuthRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  googleExchangeSchema,
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

import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { authRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  googleExchangeSchema,
} from '../validators/auth.validators';

export const authRouter = Router();

authRouter.post('/signup', authRateLimiter, validate(signupSchema), authController.signup);
authRouter.post('/login', authRateLimiter, validate(loginSchema), authController.login);
authRouter.post('/refresh', authRateLimiter, validate(refreshSchema), authController.refresh);
authRouter.post('/logout', authRateLimiter, validate(refreshSchema), authController.logout);
authRouter.get('/me', requireAuth, authController.me);

authRouter.get('/google', authController.googleRedirect);
authRouter.get('/google/callback', authController.googleCallback);
authRouter.post(
  '/google/exchange',
  authRateLimiter,
  validate(googleExchangeSchema),
  authController.googleExchange,
);

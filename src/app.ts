import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { notFoundHandler, errorHandler } from './middleware/error.middleware';

function corsOrigin(): boolean | string[] {
  if (env.CORS_ALLOWED_ORIGINS) {
    return env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  }
  // No allowlist configured: reflect any origin in development (convenient
  // for a local frontend on an arbitrary port), but fail closed in
  // production rather than defaulting to Access-Control-Allow-Origin: *
  // for every route in the API.
  return env.NODE_ENV === 'production' ? false : true;
}

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: corsOrigin() }));
  app.use(express.json());
  app.use(cookieParser(env.COOKIE_SECRET));

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

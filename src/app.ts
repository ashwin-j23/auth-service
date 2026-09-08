import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { notFoundHandler, errorHandler } from './middleware/error.middleware';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(cookieParser(env.COOKIE_SECRET));

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

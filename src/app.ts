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
  // No allowlist configured: fails closed (refuses every cross-origin
  // request) UNLESS ALLOW_ANY_CORS_ORIGIN is explicitly set — deliberately
  // NOT inferred from NODE_ENV (an earlier version checked
  // `NODE_ENV === 'production' ? false : true`, then a later one checked
  // `NODE_ENV === 'development'`; both tie "is it safe to open this up" to a
  // setting that defaults to "development" in config/env.ts and can be left
  // unset or misconfigured in a real deployment — either version means a
  // production deploy that simply forgot to set NODE_ENV stays silently wide
  // open). ALLOW_ANY_CORS_ORIGIN has no such default-to-permissive failure
  // mode: it defaults to `false`, full stop, so being open requires an
  // explicit, separate opt-in rather than an inferred one.
  return env.ALLOW_ANY_CORS_ORIGIN;
}

/**
 * Converts the TRUST_PROXY env string into whatever Express's
 * `trust proxy` setting expects. See https://expressjs.com/en/guide/behind-proxies.html
 */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value); // hop count, e.g. "1"
  return value; // preset keyword ("loopback", …) or an IP/CIDR/comma-list
}

export function createApp() {
  const app = express();

  // Left unconfigured (Express's own default: proxy trust disabled) unless
  // TRUST_PROXY is set — correct for a direct-connection local dev setup,
  // but WRONG behind any reverse proxy or load balancer: without it, every
  // request's `req.ip` (and therefore every per-IP rate limit,
  // rateLimit.middleware.ts) sees the proxy's IP, not the real client's —
  // which can mean either every user behind the proxy shares one rate-limit
  // bucket, or (since express-rate-limit validates this itself) the app
  // refusing to serve requests at all once it sees an X-Forwarded-For header
  // it wasn't told to trust.
  if (env.TRUST_PROXY !== undefined) {
    app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  }

  app.use(helmet());
  app.use(cors({ origin: corsOrigin() }));
  // Explicit limit (rather than relying on body-parser's own unmentioned
  // 100kb default) — this API only ever expects a few short string fields,
  // so bounding it tightly stops an oversized request body from being
  // buffered into memory before validation gets a chance to reject it.
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser(env.COOKIE_SECRET));

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { notFoundHandler, errorHandler } from './middleware/error.middleware';

function corsOrigin(): boolean | string[] {
  if (env.CORS_ALLOWED_ORIGINS) {
    // Already parsed AND validated into a clean string[] by env.ts's zod
    // schema (empty/malformed entries are rejected there, at boot) — no
    // re-parsing needed or wanted here.
    return env.CORS_ALLOWED_ORIGINS;
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
  // helmet() covers the general-purpose security headers (a conservative
  // CSP, X-Content-Type-Options, HSTS, etc.) but it's generic middleware —
  // it has no way to know this specific API's responses carry access/refresh
  // tokens and user data that must never be cached or handed to a browser
  // feature that has no business touching them. Two headers helmet doesn't
  // (and can't, without knowing that) set on its own:
  app.use((_req, res, next) => {
    // Told to browsers AND any intermediate cache/proxy: never store this
    // response. Without it, a shared/corporate proxy — or just the
    // browser's own disk cache — could retain a response containing a
    // freshly-issued access/refresh token or a user's profile data.
    res.setHeader('Cache-Control', 'no-store');
    // This is a JSON API with no UI of its own — it never needs camera,
    // microphone, geolocation, or payment-handling access in a browser
    // context. Explicitly disabling them is defense-in-depth: irrelevant to
    // a well-behaved client, but closes off those APIs from ever being
    // invoked in a browser context that somehow ends up rendering this
    // response directly (e.g. a misconfigured client, or a future bug).
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
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

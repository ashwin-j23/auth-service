import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  // Must be a value jwt.sign()'s `expiresIn` option actually accepts (see
  // src/utils/jwt.ts) — either a plain number of seconds, or a number plus
  // a short unit (m/h/d/w/y, optionally ms/s), e.g. "15m", "1h", "7d".
  // Validating the format here — not just "is a string" — is what makes
  // that file's "validated at startup" comment true: an invalid value now
  // fails fast at boot instead of throwing on the first login/signup call.
  JWT_ACCESS_TTL: z
    .string()
    .regex(
      /^\d+$|^\d+(\.\d+)?\s?(ms|s|m|h|d|w|y)$/,
      'JWT_ACCESS_TTL must be a number of seconds, or a value like "15m", "1h", "7d"',
    )
    .default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Included in every access token as `iss`/`aud` and checked on verify
  // (src/utils/jwt.ts) — cheap insurance that this app's tokens are only
  // ever accepted by this app, even if JWT_ACCESS_SECRET were ever reused
  // or shared with another service. Defaulted so this isn't new required
  // config for existing deployments; still independently overridable.
  JWT_ISSUER: z.string().min(1).default('auth-service'),
  JWT_AUDIENCE: z.string().min(1).default('auth-service'),

  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),

  OAUTH_SUCCESS_REDIRECT_URL: z.string().url(),

  // Comma-separated allowlist of origins allowed to call this API from a
  // browser (e.g. "https://app.example.com,https://admin.example.com").
  // See src/app.ts — unset, this means cross-origin requests are refused
  // outright, full stop, regardless of NODE_ENV.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // The ONLY way to get the reflect-any-origin convenience behavior (for a
  // local frontend running on an arbitrary port) without an explicit
  // allowlist. Deliberately its own flag, not inferred from
  // `NODE_ENV === 'development'` — NODE_ENV defaults to "development" in
  // this very schema, and is exactly the kind of setting a real deployment
  // can leave unset or misconfigured by accident. Tying "allow any origin"
  // to that string meant a production deploy that simply forgot to set
  // NODE_ENV would silently stay wide open; this flag has to be turned on
  // on purpose, in both places.
  // NOT z.coerce.boolean(): that coerces via JS's Boolean() constructor,
  // under which the *string* "false" is truthy (any non-empty string is) —
  // exactly the kind of footgun that would make ALLOW_ANY_CORS_ORIGIN=false
  // in a .env file silently mean "true". This enum+transform only accepts
  // the literal strings "true"/"false".
  ALLOW_ANY_CORS_ORIGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Express's "trust proxy" setting (see src/app.ts) — required whenever
  // this runs behind a reverse proxy/load balancer, or `req.ip` (and
  // therefore every per-IP rate limit) sees the proxy's IP for every
  // request instead of the real client's. Accepts "true"/"false", a hop
  // count ("1"), an Express preset ("loopback"), or an IP/CIDR list — see
  // https://expressjs.com/en/guide/behind-proxies.html. Left unset (Express's
  // own default: disabled) for a direct-connection local dev setup.
  TRUST_PROXY: z.string().optional(),

  // Passed straight to express.json()'s `limit` option. This is an auth API
  // with no file uploads — request bodies are a few small string fields —
  // so a generous-but-bounded explicit limit (rather than relying on
  // body-parser's own 100kb default going unmentioned anywhere in this
  // codebase) both documents the intent and stops an oversized body from
  // being fully buffered into memory before validation ever gets a chance
  // to reject it.
  JSON_BODY_LIMIT: z.string().default('10kb'),

  // Rate limiting (src/middleware/rateLimit.middleware.ts) — deliberately
  // configurable rather than hardcoded, so the limits can be tuned to real
  // traffic without a code change. Two separate budgets, on two separate
  // limiter instances: STRICT for signup/login (the actual brute-force /
  // credential-stuffing surface), STANDARD for refresh/logout/google-exchange
  // (still worth bounding, but not competing with the strict budget for the
  // same client — see rateLimit.middleware.ts for why that separation matters).
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_STRICT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_STANDARD_MAX: z.coerce.number().int().positive().default(100),
});

// Fails fast on boot (or on first import in tests — see tests/setup.ts, which
// seeds a full set of dummy values before any test module is loaded) rather
// than letting a missing secret surface later as a confusing runtime error.
export const env = envSchema.parse(process.env);

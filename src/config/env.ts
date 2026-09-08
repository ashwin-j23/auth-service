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

  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),

  OAUTH_SUCCESS_REDIRECT_URL: z.string().url(),

  // Comma-separated allowlist of origins allowed to call this API from a
  // browser (e.g. "https://app.example.com,https://admin.example.com").
  // Optional in development (falls back to reflecting any origin, for
  // convenience running a local frontend on an arbitrary port); required in
  // practice for production — see src/app.ts, which refuses all cross-origin
  // requests in production when this is unset rather than defaulting open.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

// Fails fast on boot (or on first import in tests — see tests/setup.ts, which
// seeds a full set of dummy values before any test module is loaded) rather
// than letting a missing secret surface later as a confusing runtime error.
export const env = envSchema.parse(process.env);

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),

  OAUTH_SUCCESS_REDIRECT_URL: z.string().url(),
});

// Fails fast on boot (or on first import in tests — see tests/setup.ts, which
// seeds a full set of dummy values before any test module is loaded) rather
// than letting a missing secret surface later as a confusing runtime error.
export const env = envSchema.parse(process.env);

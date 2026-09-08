# How this auth service works — line by line

This walks through every file in the order you'd actually want to read them
in: config → database schema → low-level utilities → services (the real
logic) → middleware → controllers/routes (the HTTP layer) → app wiring →
tests. Skim the headers, read closely wherever the logic is non-obvious.

---

## 1. `.env.example` — configuration

```
NODE_ENV=development
PORT=4000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/auth_service?schema=public"
JWT_ACCESS_SECRET="replace-with-a-long-random-value"
JWT_ACCESS_TTL="15m"
REFRESH_TOKEN_TTL_DAYS=7
COOKIE_SECRET="replace-with-a-long-random-value"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="http://localhost:4000/api/auth/google/callback"
OAUTH_SUCCESS_REDIRECT_URL="http://localhost:3000/oauth/callback"
```

Nothing here is code, but every one of these values is *load-bearing*:

- `DATABASE_URL` — the Postgres connection string Prisma uses.
- `JWT_ACCESS_SECRET` — the symmetric secret used to **sign and verify**
  access tokens (HMAC-SHA256, the default for `jsonwebtoken`). Anyone with
  this string can mint valid tokens for any user, so it must never be
  committed — that's why `.env` is in `.gitignore` and only `.env.example`
  (with placeholder values) is committed.
- `JWT_ACCESS_TTL` — how long an access token is valid (`15m` = 15 minutes).
  Short-lived on purpose: if one leaks, the blast radius is small.
- `REFRESH_TOKEN_TTL_DAYS` — how long a refresh token (used to get new access
  tokens without re-entering a password) stays valid before the user has to
  log in again.
- `COOKIE_SECRET` — used to *sign* (not encrypt) the short-lived cookie that
  protects the Google OAuth flow from CSRF (explained in detail in the
  controller section below).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — issued
  by Google when you register this app at
  https://console.cloud.google.com/apis/credentials. `GOOGLE_REDIRECT_URI`
  must be listed there *exactly* (scheme+host+port+path) or Google refuses
  the exchange.
- `OAUTH_SUCCESS_REDIRECT_URL` — after a successful Google login, the backend
  doesn't have any HTML to show, so it redirects the browser back to your
  frontend, with the newly-issued tokens attached.

---

## 2. `prisma/schema.prisma` — the database

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```
Tells Prisma "generate SQL for Postgres, and get the connection string from
the `DATABASE_URL` env var at runtime" — the URL itself is never hardcoded
into the schema.

```prisma
model User {
  id              String    @id @default(uuid())
  email           String    @unique
  passwordHash    String?
  name            String?
  googleId        String?   @unique
  isEmailVerified Boolean   @default(false)

  failedLoginAttempts Int      @default(0)
  lockedUntil         DateTime?
  isActive        Boolean   @default(true)

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  refreshTokens   RefreshToken[]
  @@map("users")
}
```
Line by line:
- `id String @id @default(uuid())` — primary key, a randomly generated UUID
  (not an auto-incrementing integer — harder for an outsider to guess/enumerate
  `/users/1`, `/users/2`, ...).
- `email String @unique` — a **database-level** uniqueness constraint. Even
  if two signup requests race each other past the application-level "does
  this email exist?" check, Postgres itself will reject the second `INSERT`.
  This is the actual source of truth for "no duplicate accounts" — the check
  in `auth.service.ts` is just there to *fail nicely* with a clean error
  before hitting the DB in the common case.
- `passwordHash String?` — the `?` makes it **nullable**. A user who only
  ever signed up via Google has no password at all, so there's nothing to
  hash — `null` here, not an empty string, models that correctly (and, as
  you'll see in `auth.service.ts`, `login()` explicitly refuses to treat a
  `null` password hash as "no password matches", which would otherwise be a
  subtle way to lock everyone out safely, but is worth calling out).
- `googleId String? @unique` — Google's stable per-account identifier (the
  `sub` claim in its ID tokens). Nullable because a password-only account has
  never linked Google. Unique so two different local accounts can't both
  claim to be the same Google identity.
- `isEmailVerified Boolean @default(false)` — true once we have external
  confirmation (currently: Google says so) that this address is real.
- `failedLoginAttempts Int @default(0)` / `lockedUntil DateTime?` — the
  account-level lockout `auth.service.ts`'s `login()` enforces (§10). Both
  reset to `0`/`null` on every successful login; `failedLoginAttempts`
  increments on every failed one, and `lockedUntil` gets set once it crosses
  `LOCKOUT_MAX_ATTEMPTS`. This is deliberately a *separate* mechanism from
  the per-IP rate limiting in `rateLimit.middleware.ts` — that one can't
  stop an attacker who spreads password guesses for one specific account
  across many different IPs, which is exactly the gap tracking failures on
  the account itself closes.
- `isActive Boolean @default(true)` — a *permanent*, admin-driven kind of
  "off," distinct from the self-clearing lockout above. Checked in `login()`,
  `rotateRefreshToken()`, and `GET /me` (§10, §9, §12) — the three places a
  disabled account could otherwise keep working: log in and get fresh
  tokens, use an already-issued refresh token to keep minting new access
  tokens indefinitely, or use an already-issued access token to call the one
  endpoint that reads it back.
- `updatedAt DateTime @updatedAt` — Prisma auto-updates this on every write,
  no application code needed.
- `refreshTokens RefreshToken[]` — the reverse side of the relation defined
  below; not a real column, just lets Prisma's TypeScript types express
  "a user has many refresh tokens."
- `@@map("users")` — table is named `users` in Postgres even though the
  Prisma model is `User` (singular, PascalCase is the Prisma convention;
  `users`, plural snake_case, is the SQL convention — this bridges the two).

```prisma
model RefreshToken {
  id                  String    @id @default(uuid())
  tokenHash           String    @unique
  userId              String
  user                User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt           DateTime
  revokedAt           DateTime?
  replacedByTokenHash String?
  createdAt           DateTime  @default(now())
  @@index([userId])
  @@map("refresh_tokens")
}
```
- `tokenHash String @unique` — **the raw refresh token is never stored.**
  Only a SHA-256 hash of it is. This mirrors how you'd never store a plain
  password: if the `refresh_tokens` table ever leaked (SQL injection,
  backup theft, a careless `SELECT *` in a log line), the attacker would get
  hashes, not usable tokens.
- `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`
  — a real Postgres foreign key. `onDelete: Cascade` means "if a `User` row
  is deleted, automatically delete their refresh tokens too" — no orphaned
  rows, no separate cleanup code needed.
- `revokedAt DateTime?` — `null` while the token is still usable; set to "now"
  once it's been used (rotation) or explicitly logged out. This is how
  "single-use" refresh tokens are enforced (see `token.service.ts`).
- `replacedByTokenHash String?` — when a token is rotated, this records the
  hash of the token that replaced it — an audit trail, not used for logic.
- `@@index([userId])` — speeds up "find all of this user's refresh tokens"
  queries (used when revoking everything on a suspected token-theft event).

---

## 3. `src/config/env.ts` — validating configuration at startup

```ts
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z
    .string()
    .regex(
      /^\d+$|^\d+(\.\d+)?\s?(ms|s|m|h|d|w|y)$/,
      'JWT_ACCESS_TTL must be a number of seconds, or a value like "15m", "1h", "7d"',
    )
    .refine((v) => parseFloat(v) > 0, 'JWT_ACCESS_TTL must be greater than zero')
    .default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),
  OAUTH_SUCCESS_REDIRECT_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const origins = value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
      if (origins.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '...' });
        return z.NEVER;
      }
      const originPattern = /^https?:\/\/[^\s/]+$/;
      const invalid = origins.filter((origin) => !originPattern.test(origin));
      if (invalid.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '...' });
        return z.NEVER;
      }
      return origins;
    }),
  ALLOW_ANY_CORS_ORIGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TRUST_PROXY: z.string().optional(),
  JSON_BODY_LIMIT: z.string().default('10kb'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_STRICT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_STANDARD_MAX: z.coerce.number().int().positive().default(100),
  JWT_ISSUER: z.string().min(1).default('auth-service'),
  JWT_AUDIENCE: z.string().min(1).default('auth-service'),
  OAUTH_HANDOFF_MAX_ENTRIES: z.coerce.number().int().positive().default(5000),
  LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOCKOUT_DURATION_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
});

export const env = envSchema.parse(process.env);
```
- `import 'dotenv/config'` — runs `dotenv`'s side effect of reading `.env`
  and copying its values into `process.env`, purely because this file is
  imported first (before anything reads `process.env`). This is why every
  other file imports config *from `env.ts`*, never reads `process.env`
  directly — one place owns "where configuration comes from."
- `z.coerce.number()...` — env vars are always strings (`"4000"`, not
  `4000`); `.coerce` tells zod to convert-then-validate rather than reject a
  string that looks like a number.
- `.min(16, '...')` on both secrets — a cheap guard against someone leaving
  the placeholder `"changeme"` in production; not a real strength check, but
  catches the most common mistake.
- `JWT_ACCESS_TTL`'s `.regex(...)` — this one is worth dwelling on, because
  it's fixing a real gap: `src/utils/jwt.ts` passes this value straight into
  `jwt.sign()`'s `expiresIn` option and comments that it's "validated at
  startup to be jwt.sign-compatible" — but until this regex was added, the
  schema was just `z.string()`, which accepts *any* string, including ones
  `jwt.sign` would reject at call time. That made the comment false: an
  operator setting `JWT_ACCESS_TTL=banana` would sail through
  `envSchema.parse()` at boot, and only find out something was wrong when
  the very first signup/login call threw deep inside `jsonwebtoken`. The
  regex (accepting either a bare number of seconds, or a number plus a
  short unit like `15m`/`1h`/`7d`) makes the two actually agree — an invalid
  value now fails at the same `envSchema.parse()` call as every other
  misconfiguration.
- The `.refine((v) => parseFloat(v) > 0, ...)` right after that regex closes
  a gap the regex itself *can't* — `\d+` matches a literal `0` just as
  validly as `15`, so `"0"`, `"0s"`, `"0.0h"` all pass the format check
  without complaint. That's a format that happens to describe zero duration,
  not an invalid format, so no regex rewrite fixes it — it needs an actual
  value check. Left alone, `JWT_ACCESS_TTL=0` would boot cleanly and then
  silently issue every access token already expired the instant it's
  signed, which surfaces later as "every single request is unauthorized" —
  a nasty thing to debug when the real cause is one wrong config value three
  layers away. `parseFloat("0s")` is `0`, `parseFloat("15m")` is `15` — the
  refine reads past the unit and checks the number itself.
- `CORS_ALLOWED_ORIGINS`'s `.transform(...)` does two jobs at once: **parse**
  (split on `,`, trim each piece) and **validate**, in the same pass, rather
  than a bare `z.string().optional()` that just hands `app.ts` a raw string
  to `.split(',')` itself later. That distinction matters for a real failure
  mode a bare split doesn't catch: `CORS_ALLOWED_ORIGINS=""`, `","`, or a
  value with a stray trailing comma each produce one or more empty-string
  entries once split. `cors`'s origin-matching would never actually treat an
  empty-string entry as "allow anything" — a real browser `Origin` header is
  never an empty string, so nothing would ever match it — but it would
  silently produce a broken, useless allowlist with no error telling the
  operator their config typo means "no origin will ever be allowed." The
  `.filter((origin) => origin.length > 0)` step removes harmless stray empty
  segments (a single trailing comma after an otherwise-valid origin is
  simply tolerated), but if *every* segment was empty — nothing usable
  remains — that's rejected outright via `ctx.addIssue(...)` +
  `return z.NEVER` (zod's way of failing a `.transform()`, the same
  mechanism `ALLOW_ANY_CORS_ORIGIN` doesn't need since `.enum()` fails on
  its own). The second check, `originPattern.test(...)`, catches the other
  way this can be wrong: an origin with a path or trailing slash
  (`https://example.com/callback`) or missing a scheme entirely
  (`example.com`) — never valid values for what an `Origin` header actually
  looks like, so also rejected at boot rather than silently compiled into an
  allowlist that will never match a real request. The output type is also
  `string[] | undefined` directly (not `string | undefined`), so `app.ts`
  doesn't need to re-parse this value at all — just use it.
- `ALLOW_ANY_CORS_ORIGIN` is the *only* other input `app.ts`'s CORS logic
  (§18) looks at — deliberately not `NODE_ENV`. An earlier version of that
  logic branched on
  `NODE_ENV === 'production'` (later `=== 'development'`) to decide whether
  cross-origin requests should be wide open by default; either way, that ties
  a security-relevant default to a setting (`NODE_ENV`, defaulted to
  `'development'` right above) that a real deployment can simply forget to
  set. `ALLOW_ANY_CORS_ORIGIN` defaults to `false` with no such failure mode.
- `ALLOW_ANY_CORS_ORIGIN`'s `.enum(['true', 'false']).transform(...)` rather
  than `z.coerce.boolean()` is deliberate, and worth understanding why:
  `z.coerce.boolean()` coerces via JavaScript's `Boolean()` constructor,
  under which `Boolean("false")` is `true` — **any non-empty string is
  truthy**, including the literal string `"false"`. Had this field used
  `z.coerce.boolean()`, writing `ALLOW_ANY_CORS_ORIGIN=false` in a `.env`
  file would have silently meant "true" — a classic zod footgun, caught here
  before it shipped rather than after. The `.enum(...)` only accepts the two
  literal strings and `.transform` maps them to real booleans explicitly.
- `TRUST_PROXY`, `JSON_BODY_LIMIT`, and the `RATE_LIMIT_*` trio are all plain
  strings/numbers with defaults chosen to work out of the box for local dev
  — see `app.ts` (§18) and `rateLimit.middleware.ts` (§16) for what each one
  actually controls.
- `JWT_ISSUER`/`JWT_AUDIENCE` default to `'auth-service'` — see `jwt.ts` (§7)
  for what they're checked against.
- `OAUTH_HANDOFF_MAX_ENTRIES` — see `oauthHandoff.service.ts` (§11a).
  `LOCKOUT_MAX_ATTEMPTS`/`LOCKOUT_DURATION_MS` — see `auth.service.ts`'s
  `login()` (§10). Both configurable for the same reason the rate-limit
  numbers are: so the actual thresholds can be tuned to real traffic/usage
  without a code change.
- `envSchema.parse(process.env)` — **throws immediately** if anything is
  missing or malformed. This means a missing `GOOGLE_CLIENT_SECRET` crashes
  the app the instant it starts (with a clear zod error naming the field),
  instead of surfacing three requests later as a cryptic `undefined is not a
  function` deep inside `google-auth-library`.
- Every other file does `import { env } from '../config/env'` and reads
  `env.WHATEVER` — fully typed (TypeScript infers the exact shape from the
  zod schema via `z.infer`), so a typo like `env.JWT_ACCES_SECRET` is a
  compile error, not a runtime `undefined`.

---

## 4. `src/lib/prisma.ts` — one shared database client

```ts
import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
```
Just one line of substance. The reason this is its own file rather than
`new PrismaClient()` wherever it's needed: (1) a real app should only ever
have **one** `PrismaClient` instance (it manages its own connection pool —
creating many leaks connections), and (2) it gives unit tests a single,
precise thing to replace with a mock (`jest.mock('../../src/lib/prisma', ...)`
— see the testing section at the bottom). Every service imports `prisma`
from here.

---

## 5. `src/utils/password.ts` — hashing passwords

```ts
import bcrypt from 'bcryptjs';
const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function comparePassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}
```
- **Why bcrypt, not SHA-256/MD5**: bcrypt is deliberately slow, and its cost
  (`SALT_ROUNDS`) is tunable. A generic hash function like SHA-256 is
  *fast* — great for checksums, terrible for passwords, because an attacker
  with a stolen hash table can try billions of guesses per second on cheap
  GPUs. bcrypt makes each guess expensive.
- `SALT_ROUNDS = 12` — the cost factor is `2^12` internal rounds. Each `+1`
  roughly doubles the hashing time. 12 is a reasonable balance in 2026
  (well under 100ms per hash on typical hardware, but expensive at scale for
  an attacker).
- `bcrypt.hash(...)` **automatically generates a random salt** and embeds it
  in the returned string (that's why `hashPassword('same')` called twice
  gives two *different* outputs — see the test for this). This is what
  defeats rainbow-table attacks: two users with the same password get
  completely different hashes.
- `bcrypt.compare(plain, hash)` — re-hashes `plain` using the salt/cost
  factor *extracted from `hash` itself* and does a constant-time comparison.
  You never "decrypt" a bcrypt hash — comparison is the only operation.
- `bcryptjs` (not the native `bcrypt` package) — a pure-JavaScript
  implementation. Slightly slower than the native C++ binding, but needs no
  compiler toolchain to install, which matters in constrained/sandboxed
  build environments and keeps `npm install` simple everywhere.

---

## 6. `src/utils/AppError.ts` — distinguishing "expected" from "bug" errors

```ts
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational = true;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
```
- Extends the built-in `Error` so `instanceof Error`, `.stack`, etc. all
  still work.
- `statusCode` — the HTTP status this error should produce (`409` for
  "email taken", `401` for "bad credentials", etc.) — carried *with* the
  error instead of being decided again at the point it's caught.
- `Object.setPrototypeOf(this, AppError.prototype)` — a TypeScript/Babel
  quirk: when you `extends Error` and compile down to older JS targets, the
  prototype chain can get subtly broken, making `instanceof AppError` return
  `false` for errors thrown across a compiled boundary. This line is the
  standard fix, guaranteeing `instanceof AppError` always works correctly —
  which matters because `error.middleware.ts` (below) relies on exactly that
  check to decide "known, safe-to-show-the-user error" vs. "unexpected bug,
  log it and hide the details."

---

## 7. `src/utils/jwt.ts` — signing and verifying access tokens

```ts
export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  jti: string; // unique ID for this specific token — see signAccessToken
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    jwtid: crypto.randomUUID(),
  });
}
```
- `sub` is a JWT-standard claim name (short for "subject") — using the
  standard name rather than something like `userId` means any other tool
  that understands JWTs (API gateways, other services) reads it correctly
  without custom mapping.
- `jwt.sign(payload, secret, { expiresIn })` — produces the familiar
  three-part `xxxxx.yyyyy.zzzzz` JWT string: a base64url header, a
  base64url payload (**not encrypted — anyone can decode and read it**,
  which is exactly why it only contains a user id and email, nothing
  sensitive), and an HMAC-SHA256 signature over both, computed with
  `JWT_ACCESS_SECRET`. `expiresIn` bakes an `exp` claim into the payload.
- `issuer`/`audience` add `iss`/`aud` claims — a name for "who issued this"
  and "who it's for." On their own, at sign time, these don't add
  protection — they only matter once `verify` actually checks them, next.
- `jwtid: crypto.randomUUID()` adds a `jti` claim — a random, unique ID for
  *this specific token*, freshly generated on every single call (so two
  tokens for the same user always have different `jti`s, even issued in the
  same millisecond — `signAccessToken`'s parameter type is
  `Omit<AccessTokenPayload, 'jti'>` specifically so a caller can't pass one
  in and accidentally reuse it). Nothing in this codebase actually *checks*
  it yet — there's no revocation list, and a compromised or otherwise-bad
  access token stays usable until it naturally expires (15 minutes by
  default). What `jti` buys, on its own, is the minimum groundwork such a
  list would need later: you can't blocklist an individual token without
  some way to name it. Building the list itself is deliberately left out
  for now — it needs a shared store (Redis, most likely) checked on *every*
  authenticated request, trading away a real chunk of the current design's
  fully-stateless simplicity, which is a bigger tradeoff than adding a UUID
  to a JWT and worth deferring until immediate token revocation is an actual
  requirement rather than a hypothetical one.

```ts
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if (typeof decoded === 'string' || !decoded.sub || !decoded.email || !decoded.jti) {
    throw new jwt.JsonWebTokenError('Malformed access token payload');
  }
  return { sub: decoded.sub, email: decoded.email as string, jti: decoded.jti };
}
```
- `jwt.verify` recomputes the HMAC signature using the same secret and
  compares it to the one embedded in the token; **throws** (doesn't return a
  falsy value) if the signature doesn't match, the token is expired, the
  `iss`/`aud` claims don't match what's passed here, or it's malformed. This
  is why the caller (`auth.middleware.ts`) wraps this in `try/catch`.
- Passing `issuer`/`audience` to `verify` (not just `sign`) is what actually
  does something: without it, a token with the *wrong* `iss`/`aud` — but
  otherwise correctly signed — would verify successfully anyway, since
  `jwt.verify` only checks claims it's explicitly told to check. For a
  single, self-contained service like this one, that gap is low-risk today.
  It stops being low-risk the moment `JWT_ACCESS_SECRET` is ever reused or
  shared with another service (a common shortcut when standing up a second
  internal service quickly) — without `audience` verification, a token
  legitimately issued *for that other service* would also be accepted here,
  and vice versa. Checking `iss`/`aud` is what keeps "signed with the same
  secret" from silently becoming "usable anywhere that secret is known,"
  cheaply, before there's ever a second service to worry about.
- `typeof decoded === 'string'` — `jwt.verify`'s TypeScript types allow the
  decoded value to be a plain string (for tokens signed without an object
  payload); that branch can't happen for tokens *this app* issues, but
  narrowing it here satisfies TypeScript and defensively rejects any
  oddly-shaped token from elsewhere.
- The `!decoded.sub || !decoded.email` check guards against a token that's
  cryptographically valid (right secret) but structurally wrong — belt and
  suspenders, since every token this app issues always has both fields.

---

## 8. `src/utils/publicUser.ts` — never leaking sensitive fields

```ts
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
  };
}
```
Takes the full Prisma `User` (which includes `passwordHash` and `googleId`)
and returns a **new object** containing only the fields safe to send to a
client. Every response that includes a user goes through this function —
there's no code path where the raw Prisma `User` object is handed directly to
`res.json(...)`, so a future field added to the `User` model (say, an
internal `stripeCustomerId`) doesn't automatically leak just because someone
forgot to strip it at the call site.

---

## 9. `src/services/token.service.ts` — issuing, rotating, and revoking tokens

This is the most security-sensitive file in the project. Walking through it
function by function.

```ts
function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
```
Plain SHA-256, no per-token salt. That's fine *here* (unlike passwords):
refresh tokens are generated with 48 random bytes (384 bits) of entropy —
utterly infeasible to brute-force or rainbow-table, so bcrypt's deliberate
slowness would only add cost with no security benefit. We just need a
one-way, collision-resistant digest so the DB never holds a token an
attacker could replay directly.

```ts
function generateRawRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}
```
`crypto.randomBytes` is Node's **cryptographically secure** random generator
(backed by the OS's CSPRNG) — critically different from `Math.random()`,
which is not safe for anything security-related (it's predictable). 48 bytes
→ 96 hex characters, which is what the token-service test asserts
(`toHaveLength(96)`).

```ts
function refreshTokenExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return expiry;
}
```
"Now plus N days," reading N from config rather than hardcoding it.

```ts
export async function issueTokenPair(user: User): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email });

  const rawRefreshToken = generateRawRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(rawRefreshToken),
      userId: user.id,
      expiresAt: refreshTokenExpiry(),
    },
  });

  return { accessToken, refreshToken: rawRefreshToken };
}
```
Called on signup, login, and successful Google auth. Note carefully: the
**raw** token (`rawRefreshToken`) is what's returned to the caller (and
eventually the client) — but only its **hash** is what gets written to the
database via `prisma.refreshToken.create`. This is the same "never store the
real secret" principle as passwords, applied to refresh tokens.

```ts
export async function rotateRefreshToken(rawRefreshToken: string): Promise<TokenPair> {
  const tokenHash = hashToken(rawRefreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) {
    throw new AppError(401, 'Invalid refresh token');
  }
```
Called by `POST /api/auth/refresh`. Hash whatever token the client sent, and
look it up — if nothing matches, it's either a forged token or one that's
never existed. Either way: `401`, no further detail given (deliberately
generic, so it doesn't help an attacker distinguish "wrong token" from
"right token, wrong state").

```ts
async function revokeAllTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```
A small extracted helper — "revoke every active token this user has" — used
in two places below for the same reason both times: a detected reuse/replay
of a refresh token. Pulled out once rather than duplicated so that reason
only has to be explained (and, if it ever changes, fixed) in one place.

```ts
  if (stored.revokedAt) {
    await revokeAllTokensForUser(stored.userId);
    throw new AppError(401, 'Refresh token has already been used');
  }
```
This is the **reuse-detection** logic, and the most important security
property of the whole token system. Refresh tokens are single-use — every
successful refresh immediately revokes the token that was used (see the
rotation step below) and issues a brand new one. So if this *exact* token
hash is looked up and it's *already* revoked, one of two things happened:

1. The legitimate client tried to refresh twice with the same token (a bug,
   e.g. a race condition from two tabs) — rare and not actually dangerous.
2. **An attacker has a copy of a refresh token that the legitimate user
   already rotated past** — meaning the token was stolen at some point in
   the past, and both the attacker and the real user have been using
   *different* descendants of the same original token family.

Because there's no cheap way to tell those two cases apart, the safe response
is to treat it as a theft: **revoke every other active refresh token this
user has** (logs out every device/session), forcing a fresh login everywhere.
This is a standard pattern called "refresh token rotation with reuse
detection" (used by e.g. Auth0, and described in the OAuth security BCP).

```ts
  if (stored.expiresAt < new Date()) {
    throw new AppError(401, 'Refresh token has expired');
  }
  if (!stored.user.isActive) {
    throw new AppError(401, 'This account is no longer active');
  }
```
Straightforward expiry check, separate from the revoked check above so the
error message is accurate (a stale-but-never-used token isn't "reused," it's
just old). The `isActive` check right after it closes a specific gap:
without it, an already-issued refresh token would keep working — keep
minting fresh access tokens, indefinitely, past its own natural expiry via
rotation — for an account that's since been disabled, even though
`auth.service.ts`'s `login()` (§10) already refuses that same account at the
front door. `stored.user` is available here for free (the earlier
`findUnique` already `include`s it, to sign the access token below), so this
costs nothing extra to check. Unlike `login()`'s deliberately generic
"Invalid email or password" (used everywhere in that function specifically
to avoid confirming account existence to a guessing attacker), this message
can afford to be specific: reaching this line already requires possessing
one particular, high-entropy refresh token, not a guessable credential, so
there's no meaningful enumeration risk in saying exactly why it stopped
working.

```ts
  const newRawRefreshToken = generateRawRefreshToken();
  const newTokenHash = hashToken(newRawRefreshToken);

  const rotated = await prisma.$transaction(async (tx) => {
    const claim = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
    });
    if (claim.count === 0) {
      return false;
    }
    await tx.refreshToken.create({
      data: {
        tokenHash: newTokenHash,
        userId: stored.userId,
        expiresAt: refreshTokenExpiry(),
      },
    });
    return true;
  });

  if (!rotated) {
    await revokeAllTokensForUser(stored.userId);
    throw new AppError(401, 'Refresh token has already been used');
  }

  const accessToken = signAccessToken({ sub: stored.user.id, email: stored.user.email });
  return { accessToken, refreshToken: newRawRefreshToken };
}
```
This is the trickiest part of the whole codebase, and worth being precise
about — an earlier version of this function had a real race condition here,
found in code review, that's worth understanding even though it's fixed now.

**The bug it replaced.** The earlier version, after the two checks above,
just ran an unconditional `update` (by `stored.id`) to revoke the old row
and an `insert` for the new one, in a transaction. That transaction keeps
the *database* consistent (never "revoked but no replacement exists"), but
it does nothing about a **read-then-write race between two concurrent calls
to this function**. Picture a stolen refresh token being replayed by an
attacker at almost the exact moment the legitimate user's client refreshes
normally: both calls run their `findUnique` (the read, earlier in this
function) before either has written anything, so *both* see
`revokedAt: null` and *both* pass the reuse check above. Both then proceed
to the old unconditional `update` — and since neither write was
*conditioned* on what the other one did, both succeed, each producing its
own valid new refresh token from the same old one. That's exactly the
single-use guarantee this whole function exists to provide, silently broken.

**The fix.** `tx.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, ... })`
looks redundant with the `if (stored.revokedAt)` check above — same
condition, checked twice — but it isn't, because it's checked at a
*different time* and in a *different place*. The `if` check above reads
`stored`, an in-memory snapshot taken at the *start* of this function. This
`updateMany`'s `WHERE revokedAt: null` is evaluated by Postgres against the
row's *actual, current* state at the moment of the write — and Postgres
serializes concurrent writers to the same row (the second writer's `UPDATE`
blocks until the first commits, then re-evaluates its `WHERE` clause against
the now-committed data). So in the race above: both calls' reads see
`revokedAt: null`, both pass the `if` check, both reach this `updateMany` —
but only the *first* one to actually execute the write finds a row where
`revokedAt` is still `null` and updates it (`claim.count === 1`); the
second one's `WHERE` clause, evaluated after the first's write committed,
now matches zero rows (`claim.count === 0`). This pattern — a conditional
update whose `WHERE` re-checks the state you're relying on, rather than an
unconditional write following an earlier read — is the standard way to
implement compare-and-swap against a database row, and it's what actually
closes the race, not the transaction wrapping it (the transaction's job is
narrower: making the claim-then-insert pair atomic, so a crash between them
can't leave a revoked token with no replacement).

`claim.count === 0` is treated exactly like the "already revoked" branch
above (`revokeAllTokensForUser` + the same `401`) — from the caller's
perspective, losing this race looks identical to replaying an already-used
token, because functionally, in the scenario that makes this race possible
at all (a stolen token replayed concurrently with legitimate use), that's
exactly what happened.

```ts
export async function revokeRefreshToken(rawRefreshToken: string): Promise<void> {
  const tokenHash = hashToken(rawRefreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```
Powers logout. `updateMany` (rather than `update`) with a `where` clause
that includes `revokedAt: null` means: if the token doesn't exist, or is
already revoked, this simply affects zero rows — **no error thrown**. Logout
is idempotent on purpose: calling it twice, or with a stale token, should
never be treated as a failure from the client's perspective.

---

## 10. `src/services/auth.service.ts` — signup and login

```ts
// src/utils/email.ts — shared by this file AND google.service.ts
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}
```
`Jane@Example.com`, ` jane@example.com`, and `jane@example.com` should all be
the *same* account. Normalizing before every lookup/insert means the `@unique`
constraint on `email` in the schema actually behaves the way a user expects.
This function lives in its own `src/utils/email.ts` (not duplicated locally)
specifically because `google.service.ts` needs the exact same normalization —
if the two files each implemented this independently, a tweak to one applied
to only one of them would make the two files disagree about what "the same
email" means, and the Google-account-linking logic in `google.service.ts`
(§11) depends entirely on that agreement to work.

`.normalize('NFC')` is worth its own explanation, because the bug it closes
is genuinely non-obvious. Unicode allows the *same visual character* to be
encoded more than one way: "é" can be a single precomposed codepoint
(U+00E9, the "NFC" — Normalization Form C — encoding) or built from "e" plus
a separate combining acute-accent codepoint (U+0065 U+0301, "NFD"). Both
render identically in every font, mean the same thing to a human, and are
completely different strings byte-for-byte to a computer — so without this,
`josé@example.com` typed on a system that produces NFC and the *same address*
typed on one that produces NFD (both happen in the wild — it depends on
input method, OS, and the software in between) would be treated as two
different emails: two different rows able to exist past the `@unique`
constraint despite a human reading them as the exact same address, and,
concretely for this app, a real way `google.service.ts`'s email-based
account-linking lookup could miss a genuine match. `.normalize('NFC')`
collapses both encodings to one canonical form before anything else touches
the string — applied before `.toLowerCase()`, so case-folding always runs on
already-normalized input, not the other way around.

```ts
export async function signup(input: SignupInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await prisma.user.create({
      data: { email, passwordHash, name: input.name },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new AppError(409, 'An account with this email already exists');
    }
    throw err;
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}
```
Normalize → check for a duplicate → hash the password (never
`data: { password: input.password }`) → create the row → issue tokens, so a
freshly-signed-up user is logged in without a separate login call. Note the
comment in the code explicitly justifying why this endpoint *is* specific
about "email already exists" (unlike login, next) — it's a public signup
form, so confirming an email is taken isn't a meaningful leak, and a vague
error here would just be confusing.

The `try`/`catch` around `prisma.user.create` is closing a race that the
`findUnique` check above **cannot** close by itself, no matter how it's
written — this is worth understanding precisely, because it's a general
shape of bug, not specific to this one function. Two signup requests for the
same email, arriving close enough together: both run `findUnique` before
either has written anything, so both see "no existing user" and both proceed
to `create`. Only one `INSERT` can actually succeed — Postgres's own
`@unique` constraint on `email` (`prisma/schema.prisma`, §2) is what
actually prevents two rows with the same email from existing, and it does
so correctly regardless of timing, because unlike the `findUnique` check
(a read, followed later by a separate write, with an unguarded window
between them) the constraint is enforced by the database *at the moment of
the write itself*. The `findUnique` check is real and useful — it's what
lets the *overwhelming majority* of duplicate-signup attempts fail fast with
a clean `409` *without* paying the cost of hashing a password first — but
it's a fast path, not the guarantee. Without the `try`/`catch`, the loser of
that race would throw a raw `PrismaClientKnownRequestError` (Prisma's name
for a known-shape database error; code `P2002` specifically means "unique
constraint violated") that isn't an `AppError`, so `errorHandler` (§14)
would fall through to its generic branch and answer with a `500` — true, but
misleading: nothing is actually broken, the person just needs to log in
instead. Catching `P2002` specifically (not catching *every* error here,
which would risk mislabeling an unrelated database problem as "email taken")
turns that into the same clean `409` the fast path returns.

```ts
export async function login(input: LoginInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  const invalidCredentials = () => new AppError(401, 'Invalid email or password');

  if (!user || !user.passwordHash) {
    throw invalidCredentials();
  }
  if (!user.isActive) {
    throw invalidCredentials();
  }

  const isLocked = user.lockedUntil !== null && user.lockedUntil > new Date();
  if (isLocked) {
    throw invalidCredentials();
  }

  const passwordMatches = await comparePassword(input.password, user.passwordHash);

  if (!passwordMatches) {
    const attemptsBeforeThisOne = user.lockedUntil !== null ? 0 : user.failedLoginAttempts;
    const attempts = attemptsBeforeThisOne + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= env.LOCKOUT_MAX_ATTEMPTS
            ? new Date(Date.now() + env.LOCKOUT_DURATION_MS)
            : null,
      },
    });
    throw invalidCredentials();
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil !== null) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}
```
The important design decision from before still holds and is worth
restating precisely now that there's more happening in this function:
**every failure condition — no such account, no password set (Google-only),
disabled, currently locked out, or simply the wrong password — throws the
exact same `invalidCredentials()` error, with the same message and status.**
This is deliberate: if any of those returned a *different* message, an
attacker could use the login endpoint to enumerate real accounts (try a list
of addresses, see which ones say something other than "wrong password") or
learn something about a specific account's state (locked? disabled?) just
by watching how the error differs. Login is attacker-facing in a way signup
isn't (credential-stuffing bots hit login endpoints, not signup endpoints),
so it gets the more paranoid treatment throughout — every new check added
below follows that same rule, not just the original three.

**The lockout mechanism, read top to bottom:**

- `if (!user.isActive) throw invalidCredentials();` — checked before
  anything password-related. A disabled account can never succeed regardless
  of what's typed, so there's nothing to gain by comparing the password or
  touching lockout bookkeeping for it — same generic message as always, no
  wasted work.
- `isLocked` — `lockedUntil !== null && lockedUntil > new Date()`. Note this
  is **not** just `lockedUntil !== null`: a `lockedUntil` that's set but in
  the *past* means a previous lockout that has since expired, which is a
  meaningfully different state (handled a few lines down), not a current
  lock. Rejected here, before `comparePassword` ever runs — on top of not
  leaking lockout state via a different message, this also means a
  currently-locked account doesn't pay bcrypt's ~50-100ms-per-guess cost, a
  small extra brake on an attacker hammering it during the lockout window.
- On a wrong password: `attemptsBeforeThisOne` is where the one genuinely
  subtle piece of logic lives. Naively, this would just be
  `user.failedLoginAttempts` — but that undercounts one real case: a lockout
  that has already *expired* (checked above and found not-currently-locked)
  still has its old `failedLoginAttempts` sitting at the limit from before.
  Using that stale count directly would mean a user re-locks on their very
  first mistake after cooldown, forever — effectively a permanent lock with
  extra steps. `user.lockedUntil !== null` (true for an expired-but-still-set
  lock, same condition `isActive`'s check doesn't care about but this one
  does) is the signal to start over at `0` instead, giving a fresh, full
  attempt budget once the cooldown has genuinely passed — exactly like a
  brand new set of attempts, not a continuation of the old one.
- `attempts >= env.LOCKOUT_MAX_ATTEMPTS ? new Date(Date.now() + env.LOCKOUT_DURATION_MS) : null`
  — crosses the threshold → lock for `LOCKOUT_DURATION_MS` from *now*, not
  from whenever the first failed attempt happened; hasn't crossed it yet →
  explicitly `null` (not left alone), which matters for the "expired lock"
  case above: it fully clears the old lock timestamp the moment a fresh
  attempt sequence starts, rather than leaving a past-but-nonzero
  `lockedUntil` around to confuse the next read of this same logic.
- On success: `failedLoginAttempts` and `lockedUntil` are both reset to
  `0`/`null` — but *only if there's actually something to reset*
  (`user.failedLoginAttempts > 0 || user.lockedUntil !== null`), skipping a
  needless database write for the overwhelmingly common case of a clean
  login history. Note this reset runs even for an *expired* lock, not just
  an active one — a successful login is always a fully clean slate,
  regardless of what state the account's lockout bookkeeping happened to be
  in beforehand.
- **Why account-level lockout at all, alongside the per-IP rate limiting in
  `rateLimit.middleware.ts`?** They defend against different attackers. The
  per-IP limiter caps how many requests *one IP* can make against *any*
  account — it does nothing to stop an attacker who has, or can rotate
  through, many different IPs (a botnet, a VPN pool, plain CGNAT) all aimed
  at *one specific* account's password. Tracking failures on the account
  itself, independent of where the requests came from, closes exactly that
  gap; neither mechanism replaces the other.

---

## 11. `src/services/google.service.ts` — the OAuth exchange and account linking

```ts
function buildOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}
```
`OAuth2Client` from `google-auth-library` is a small wrapper around the
standard OAuth 2.0 "authorization code" flow, pre-configured for Google's
endpoints.

```ts
export function getGoogleAuthUrl(state: string): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent',
    state,
  });
}
```
Builds the URL the browser gets redirected to (Google's consent screen).
- `scope: ['openid', 'email', 'profile']` — the minimum needed to identify
  the user and get their email/name; not requesting Gmail, Drive, or any
  other scope this app doesn't use (principle of least privilege — asking
  for more looks suspicious to users and is unnecessary risk if the token
  ever leaked).
- `access_type: 'online'` — we don't need a Google *refresh* token (we mint
  our own session tokens after this one-time login), so we don't ask for
  offline access.
- `state` — an unguessable random value generated by the controller (see
  §12) and threaded through here. This is the CSRF defense for the whole
  flow, explained fully in the controller section.

```ts
export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const client = buildOAuthClient();
  let idToken: string | undefined | null;
  try {
    const { tokens } = await client.getToken(code);
    idToken = tokens.id_token;
  } catch {
    throw new AppError(400, 'Failed to exchange Google authorization code');
  }
  if (!idToken) {
    throw new AppError(400, 'Google did not return an ID token');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new AppError(400, 'Google ID token is missing required claims');
  }

  return {
    googleId: payload.sub,
    email: normalizeEmail(payload.email),
    emailVerified: payload.email_verified ?? false,
    name: payload.name ?? null,
  };
}
```
Two network calls to Google, both server-to-server (the `code` never touches
the browser again after Google's redirect delivers it):
1. `client.getToken(code)` — the backend, authenticating itself with
   `GOOGLE_CLIENT_SECRET`, trades the one-time `code` for Google's own
   tokens, including an `id_token` (a JWT *Google* signed, describing the
   logged-in user).
2. `client.verifyIdToken({ idToken, audience: ... })` — cryptographically
   verifies that JWT was really signed by Google (using Google's published
   public keys, fetched/cached internally by the library) and that it was
   issued *for this app specifically* (the `audience` check — without it, an
   ID token meant for a completely different Google-integrated app could be
   replayed here).
- `payload.email_verified ?? false` — Google itself distinguishes verified
  vs. unverified emails (e.g., some enterprise/G Suite setups); default to
  the safe assumption (`false`) if the claim is somehow absent.
- `normalizeEmail(...)` — imported from `src/utils/email.ts`, the exact same
  function `auth.service.ts` uses (§10). Written out locally here as
  `payload.email.trim().toLowerCase()` in an earlier version, which worked
  identically *today* but meant two files independently encoded the same
  rule — the kind of duplication that's easy to update in one place and
  forget in the other. Reusing the one function means there's only one
  definition of "the same email" for the account-linking lookup below to
  ever disagree with.

```ts
export async function findOrCreateGoogleUser(profile: GoogleProfile) {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
  });

  if (existing?.googleId === profile.googleId) {
    return existing;
  }

  if (existing) {
    if (!profile.emailVerified) {
      throw new AppError(400, 'Google account email is not verified');
    }
    try {
      return await prisma.user.update({
        where: { id: existing.id },
        data: { googleId: profile.googleId, isEmailVerified: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
        if (winner && winner.email === existing.email) {
          return winner;
        }
        throw new AppError(409, 'This Google account is already linked to a different user');
      }
      throw err;
    }
  }

  return prisma.user.create({
    data: {
      email: profile.email,
      googleId: profile.googleId,
      name: profile.name,
      isEmailVerified: profile.emailVerified,
      passwordHash: null,
    },
  });
}
```
Same three cases as before, but now found with **one** query instead of two
sequential ones:
1. **Already linked** — `existing.googleId === profile.googleId` — this
   exact Google account has logged in before → return the existing user,
   nothing to write.
2. **Email matches an existing (e.g. password-based) account, not yet
   linked to Google** (`existing` is set, but its `googleId` isn't this
   profile's) — link them, *but only if `profile.emailVerified` is true*.
   This `if` is the one line standing between this feature and a real
   account-takeover vulnerability: without it, anyone who controls *any*
   Google account claiming to be `victim@example.com` (Google lets you
   create an account with an *unverified* alternate email in some flows)
   could "log in with Google" as that email and get silently linked to — and
   therefore able to log into — the victim's existing password account.
   Requiring Google's own verification closes that off. Linking is wrapped
   in a `try`/`catch` for a reason that's easy to miss on a first read,
   because most of the time this `update` can't possibly conflict with
   anything — it's setting `googleId` on a row by its own `id`, not
   creating anything new. The conflict comes from `googleId`'s own
   `@unique` constraint (schema, §2) racing against *itself*: if two
   requests both read `existing` with `googleId: null` before either writes
   (the same double-click/two-tabs shape as the `create()` race in case 3,
   below), both proceed to `update`, and only the first one to actually
   commit succeeds — the second hits `P2002` on the very constraint that's
   supposed to guarantee one Google account maps to one user. Without the
   catch, that second request would throw a raw, unhandled database error
   into `errorHandler`'s generic `500` branch, on what — from that specific
   Google account's perspective — was still a login that should have
   worked. The `catch` re-fetches by `googleId` and checks whose row it
   actually landed on: if it's the **same** account (`winner.email ===
   existing.email`) — the benign race, the other request just won it first
   — return that row, no real failure occurred. If it's a **different**
   account entirely, that's not a race at all; it means this exact
   `googleId` was already, genuinely, linked to someone else, and silently
   handing back the wrong user here would be a real bug — that path throws
   a distinct `409` instead of papering over a real conflict as if it were
   a harmless retry.
3. **No match at all** (`existing` is `null`) — brand new user,
   `passwordHash: null` (they can never log in with a password — only
   Google — unless a "set a password" feature is added later). The `create()`
   for this case is wrapped in a `try`/`catch` for exactly the same reason as
   `auth.service.ts`'s `signup()` (§10): the `findFirst` above is a fast-path
   check, not a guard. Two Google logins for the same brand-new account
   arriving close together (a double-click on "Continue with Google," or two
   tabs) can both see "no existing user" and both reach `create()` — only one
   `INSERT` can win against the `email`/`googleId` unique constraints.
   Without the catch, the loser would throw a raw, unhandled
   `PrismaClientKnownRequestError` straight into `errorHandler`'s generic
   `500` branch, on what is, from that user's perspective, a *successful*
   login. The catch specifically checks for Prisma's `P2002` (unique
   constraint violation) code and, on that specific error, re-runs the same
   `findFirst` lookup — the concurrent request that won the race already
   created (or linked) the row, so fetching it and returning it is the
   correct outcome, not a failure. Any other error still propagates
   unchanged.

**Why one query is safe here, not just faster.** The earlier version ran
`findUnique` by `googleId`, and only if that missed, a *second* `findUnique`
by `email` — two round trips to Postgres on the hot path of every Google
login, even though at most one of them could ever find anything on a normal
account (both columns are `@unique`, and a user's `googleId` is only ever
set together with, or onto, the row for their one `email` — see the schema,
§2). Combining them into a single `findFirst` with an `OR` returns the same
answer in one round trip in every realistic case. The one thing this
collapsed query can't distinguish on its own is *which* branch of the `OR`
matched, if you needed to know that in general — which is exactly why the
code doesn't rely on knowing that; instead it re-derives it with
`existing?.googleId === profile.googleId`, a check against the row Postgres
actually returned, not an assumption about how it got matched.

```ts
export async function loginWithGoogleCode(code: string): Promise<GoogleLoginResult> {
  const profile = await exchangeCodeForProfile(code);
  const user = await findOrCreateGoogleUser(profile);
  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}
```
Glues the three pieces together: verify with Google → find/create the local
user → issue this app's own JWT/refresh token pair (from here on, this app
never needs to talk to Google again for this session — it's a completely
independent, self-issued token). The caller — `googleCallback` in the
controller, §12 — doesn't hand these tokens straight to the browser, though;
see the handoff mechanism right below for why.

---

## 11a. `src/services/oauthHandoff.service.ts` — getting tokens past a redirect safely

`googleCallback` (§12, next) is a `GET` route — Google itself redirects the
browser there, so this app doesn't get to choose the HTTP method or send a
JSON body back the way `signup`/`login`/`refresh` do. The only thing a
server can hand back to a browser mid-redirect is another redirect, i.e. a
URL. An earlier version of this code took the obvious-looking shortcut of
putting the freshly-issued tokens directly into that URL's query string
(`?accessToken=...&refreshToken=...`). That works, but a URL isn't a private
channel the way a JSON response body is: it can end up preserved in the
browser's history, logged by the frontend's own web server (URLs are
routinely written to access logs; response bodies aren't), or sent onward in
a `Referer` header to any third-party resource the landing page happens to
load (an ad, an analytics script, a font). None of those are exotic
attacks — they're just what URLs *do* by default — and the token being
leaked this way is a long-lived refresh token, not a 15-minute access token.

The fix follows the same shape OAuth itself already uses for the outer
flow: Google doesn't hand back real credentials in its own redirect either —
it hands back a short-lived, single-use authorization `code`, which the
*backend* (not the browser) then exchanges, server-to-server, for the real
thing. This file does the identical trick one layer further in: the backend
hands the *browser* a short-lived, single-use handoff `code` instead of the
tokens, and the frontend immediately exchanges that code — via a normal
`POST` with a JSON body, not a URL — for the real tokens.

```ts
interface HandoffEntry {
  user: PublicUser;
  tokens: TokenPair;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 60 * 1000; // must be exchanged within 1 minute
const store = new Map<string, HandoffEntry>();
```
The store itself is deliberately as simple as it can be: a plain in-memory
`Map`, keyed by the handoff code, valued with whatever `googleCallback`
already computed (the public user + token pair) plus an expiry timestamp.
Living only in process memory is a real, named limitation (see
`README.md`'s security notes) — it means a handoff created on one backend
instance is invisible to a different instance, which matters the moment
there's more than one process behind a load balancer. It's the right choice
*for this project's stated scope* (a single backend instance) precisely
because it adds no new infrastructure dependency; swapping it for Redis or a
short-lived database row later is a contained change, since every other file
only ever calls `createHandoff`/`consumeHandoff`, never touches `store`
directly.

```ts
function purgeExpired(): void {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (entry.expiresAt < now) store.delete(code);
  }
}

export function createHandoff(user: PublicUser, tokens: TokenPair): string {
  purgeExpired();
  if (store.size >= env.OAUTH_HANDOFF_MAX_ENTRIES) {
    console.error(
      `oauthHandoff: store is full (${env.OAUTH_HANDOFF_MAX_ENTRIES} entries) — rejecting a new handoff rather than evicting someone else's pending login.`,
    );
    throw new AppError(503, 'Too many sign-ins in progress right now — please try again');
  }
  const code = crypto.randomBytes(24).toString('hex');
  store.set(code, { user, tokens, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return code;
}
```
`purgeExpired()` runs on every `createHandoff` call rather than on a timer —
simple, and sufficient for the *expected* case: since a real OAuth login is
the only thing that ever calls this, the store can only ever accumulate
entries roughly as fast as people log in, and each login opportunistically
sweeps out anything stale. `env.OAUTH_HANDOFF_MAX_ENTRIES` (default 5000) is
a second, independent safeguard on top of that, not a replacement for it —
a defensive backstop for a case `purgeExpired()` alone doesn't cover: a
*sustained burst* of logins, all landing within the same ~60-second TTL
window, faster than they individually expire. Nothing about that scenario
is a bug in the purge logic — it's just what "bounded by TTL, not by count"
means, and in a long-running process, an unbounded burst is still a way to
grow this map without limit.

**What happens at the cap is worth explaining carefully, because an earlier
version of this function got it wrong in a subtle way.** That version
evicted the *oldest* entry (`store.keys().next().value` — `Map` iterates in
insertion order, so that's reliably the one closest to its own natural
expiry) to make room for the new one. It reads as a "least harm" choice —
evict whichever entry was going to expire soonest anyway — but it's still a
real harm, not a free backstop: that entry belongs to someone whose Google
login already *succeeded* and who just hasn't finished the final exchange
step yet. Evicting it fails *their* login, silently, for a reason that has
nothing to do with anything they did — a confusing, unattributable failure
landing on a completely different, innocent request than the one that
actually caused the overload.

The current version instead **rejects the new request** — throws `AppError(503, ...)`
— and leaves every existing entry untouched. This is the standard answer
for any bounded resource under pressure: when the caller has a reasonable
fallback (here, "retry the Google login" — a completely normal recovery
path for a transient `503`), it's better to fail the one request that's
actually causing the overload than to reach backward and silently corrupt
state that belongs to somebody else's already-succeeding flow. Concretely,
that means the *4th* login attempt (once the store is holding
`OAUTH_HANDOFF_MAX_ENTRIES` entries) is the one that fails — not some
arbitrary earlier login that did nothing wrong. `console.error(...)` fires
exactly when this actually happens (not on every `createHandoff` call, and
not during ordinary TTL-based purging) — deliberately, so reaching this cap
at all is the kind of thing that shows up in logs/monitoring, not a silent
one-off. `OAUTH_HANDOFF_MAX_ENTRIES` defaults to 5000 specifically to make
hitting it vanishingly unlikely under realistic traffic in the first
place — it means 5000 genuine, successful Google logins landed within the
same ~60s window without being exchanged, which requires actual valid
Google accounts completing actual consent screens, not something trivially
scriptable at volume.

`crypto.randomBytes(24)` — the same cryptographically-secure random source
used for refresh tokens (`token.service.ts`, §9) — generates the code
itself; guessing a valid one is infeasible for the same reason guessing a
refresh token is.

```ts
export function consumeHandoff(code: string): { user: PublicUser; tokens: TokenPair } | undefined {
  const entry = store.get(code);
  store.delete(code);
  if (!entry || entry.expiresAt < Date.now()) {
    return undefined;
  }
  return { user: entry.user, tokens: entry.tokens };
}
```
`store.delete(code)` runs **unconditionally**, before the expiry check —
this is what makes the code single-use even in the failure case. If it only
deleted on the success path, a client that raced to exchange an
already-expired-but-not-yet-purged code could, depending on timing, still
find it present; deleting first and validating after means a code is
consumed by the *first* call that looks it up, full stop, whether that call
succeeds or not.

---

## 12. `src/controllers/auth.controller.ts` — the HTTP layer

Controllers are intentionally thin: parse the request, call a service,
shape the response. All the actual logic lives in the services above.

```ts
export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.signup(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}
```
`201 Created` (not `200`) — correct REST status for "a new resource was
created." Every controller function follows this exact `try { ... } catch
(err) { next(err) }` shape: Express doesn't automatically catch rejected
promises in async route handlers (this matters for Express 4, used here —
Express 5 fixes this), so every `await` that can throw is manually forwarded
to `next(err)`, which routes it to `errorHandler` (see §14).

```ts
export async function me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) {
      throw new AppError(401, 'Not authenticated');
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }
    if (!user.isActive) {
      throw new AppError(403, 'This account has been disabled');
    }
    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}
```
This route is only reachable after `requireAuth` middleware has already run
(see the route definitions in §17), so `req.user` is always set in practice
— the `if (!req.user)` check is a defensive fallback for the type checker
and against future misconfiguration, not a real code path today. Notice it
re-fetches the user from the database rather than just trusting the JWT
payload: the JWT only proves "this was the user at token-issue time" — if
the account is deleted or disabled after the token was issued, a fresh DB
read reflects that; the JWT payload itself is a signed snapshot that can go
stale the moment anything about the account changes.

The `isActive` check is exactly that kind of gap being closed: a JWT is
self-contained and stateless by design (§7) — it stays cryptographically
"valid" purely by having the right signature and not yet being past its
`exp`, with no way for the token itself to know an admin disabled the
account five minutes after it was issued. `me` already does a database read
on every call regardless, so checking `isActive` here costs nothing extra —
a natural, low-cost place to close that gap, and (together with the same
check now also in `login()` and `rotateRefreshToken()`, §10/§9) means a
disabled account can't keep functioning through any of the three paths that
would otherwise let it. The status is `403` here, not the generic-`401`
pattern `login()` uses for its own checks — deliberately different, and
fine specifically because there's no enumeration concern to protect against
on this route: the caller has already proven their identity by presenting a
valid, signed token for this exact account, so being specific about *why*
access was refused doesn't hand an attacker anything they didn't already
have.

Now the OAuth handlers — this is the part worth reading most carefully:

```ts
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  signed: true,
};

export function googleRedirect(_req: Request, res: Response) {
  const state = crypto.randomBytes(24).toString('hex');

  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...OAUTH_STATE_COOKIE_OPTIONS,
    maxAge: 5 * 60 * 1000,
  });

  res.redirect(googleService.getGoogleAuthUrl(state));
}
```
This is `GET /api/auth/google` — the very first step. It:
1. Generates a random, unguessable `state` value.
2. Stores it in a cookie on the user's browser — `httpOnly` (JavaScript on
   the page can't read it, blocking XSS from stealing it), `secure` in
   production (only sent over HTTPS), `sameSite: 'lax'` (still sent on the
   top-level redirect *back* from Google, which is what's needed here, while
   still blocking most cross-site abuse), and `signed: true` (Express signs
   it with `COOKIE_SECRET` so it can detect if the cookie value was tampered
   with client-side).
3. Redirects the browser to Google, **also** embedding that same `state` in
   the URL Google will eventually redirect back to.

`OAUTH_STATE_COOKIE_OPTIONS` is pulled out into its own constant, shared
with `googleCallback` below, and it's worth explaining why that's not just
tidiness. An earlier version of this file set this cookie with exactly these
options here, but *cleared* it in `googleCallback` with
`res.clearCookie(OAUTH_STATE_COOKIE)` — no options at all. That's a real
gap, not a style nit: a cookie is only reliably overwritten/cleared by a
`Set-Cookie` response whose attributes (`Path`, `Secure`, `SameSite`, in
particular) match how it was originally set — mismatched attributes can mean
the browser treats the clearing response as describing a *different*
cookie and leaves the original sitting in place. Sharing one constant
between the `set` and `clear` calls makes it structurally impossible for
the two to drift apart again.

```ts
function validateOAuthCallback(query: Request['query'], cookieState: unknown): string {
  const { code, state } = query;
  if (typeof code !== 'string') {
    throw new AppError(400, 'Missing authorization code');
  }
  if (!state || !cookieState || state !== cookieState) {
    throw new AppError(400, 'Invalid or missing OAuth state');
  }
  return code;
}

export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const cookieState = req.signedCookies?.[OAUTH_STATE_COOKIE];
    let code: string;
    try {
      code = validateOAuthCallback(req.query, cookieState);
    } finally {
      res.clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_OPTIONS);
    }

    const { user, tokens } = await googleService.loginWithGoogleCode(code);

    const handoffCode = createHandoff(user, tokens);

    const redirectUrl = new URL(env.OAUTH_SUCCESS_REDIRECT_URL);
    redirectUrl.searchParams.set('code', handoffCode);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    next(err);
  }
}
```
**The ordering here — validate first, clear second — is deliberate, and an
earlier version of this function had it backward: it called
`res.clearCookie(...)` as the very first thing, *before* checking whether
`code`/`state` were even present, let alone valid.** For *this specific*
request that ordering never actually broke anything — `cookieState` is read
into a local variable up front regardless of when the cookie gets cleared
afterward, so the validation below always sees the right value either way.
But it's still the wrong shape of code, and worth understanding why "no
observed bug for this input" isn't the same as "correct": clearing a cookie
is a side effect on the *response* — it's the function declaring "this
attempt has been consumed" — and doing that before confirming the attempt
was ever real means every rejected callback (a bare `GET` to this URL with
no query params, a forged `code`/`state`, a replayed old request) still
gets to consume the real CSRF state cookie for whatever *legitimate* OAuth
attempt might actually be in flight in that same browser. This is the
standard shape for any single-use security token, not specific to OAuth:
validate first, and only *then* burn it — the same "burn after a single
successful use" principle behind this app's own refresh-token rotation (§9)
and handoff codes (§11a). `validateOAuthCallback` is deliberately pure — no
`req`/`res` mutation at all, just query params in, a `code` or a thrown
`AppError` out — specifically so it can't accidentally reach for `res`
itself; the `try { ... } finally { res.clearCookie(...) }` wrapped around
just that one call is what ties "we attempted to consume this state" to
clearing the cookie, guaranteed to run exactly once whether validation
threw or not, without smearing that side effect earlier across the
function than it needs to be.
This is `GET /api/auth/google/callback` — where Google redirects the browser
back to, with `?code=...&state=...` in the URL (Google's own authorization
`code`, not to be confused with the handoff `code` this function creates a
few lines later — same word, two different codes, one consumed here to talk
to Google, one just minted to hand to the browser). The **state check is the
whole point**: it compares the `state` Google echoed back (which came from
the URL a real user's browser was sent to) against the `state` stored in
this browser's signed cookie (set in the step above, on *this same
browser*). If they don't match — or the cookie is missing entirely — the
request is rejected before ever calling Google to exchange the code.

Why this matters: without the `state` check, an attacker could start their
*own* Google OAuth flow, get a valid `code` for *their own* Google account,
and then trick a victim's browser into visiting
`/api/auth/google/callback?code=<attacker's code>` (e.g. via a crafted link
or auto-submitting form). If the backend blindly exchanged that code, it
would log the victim's browser into the *attacker's* account — a "session
fixation" / login CSRF attack. Because the code only works if it arrives
alongside the exact `state` value tied to a cookie already sitting in *that*
browser, an attacker can't forge it — they'd need to also control the
victim's cookies, which they don't.

Once state is verified, `loginWithGoogleCode(code)` does the real work
(§11) and returns the real `user`/`tokens` — but notice those never reach
`redirectUrl` directly. Instead, `createHandoff(user, tokens)` (§11a) stashes
them and returns an opaque, single-use `handoffCode`, and *that* is the only
thing put in the redirect URL. The browser lands on the frontend knowing
nothing more than "a login just succeeded, here's a code" — the actual
tokens only ever travel in a POST body, next.

```ts
export async function googleExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const result = consumeHandoff(req.body.code);
    if (!result) {
      throw new AppError(400, 'Invalid, expired, or already-used exchange code');
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
```
This is `POST /api/auth/google/exchange` — the frontend calls it the instant
it lands on `OAUTH_SUCCESS_REDIRECT_URL?code=...`, trading that code for the
real `{ user, tokens }`. `consumeHandoff` (§11a) does the heavy lifting:
returns `undefined` for anything not currently valid — wrong code, expired,
or already exchanged once — which this function turns into a single, generic
`400` rather than three different messages (deliberately: distinguishing
"expired" from "wrong" from "already used" here would tell an attacker
probing this endpoint more than they need to know, the same enumeration
concern login's error message avoids, §10).

---

## 13. `src/middleware/auth.middleware.ts` — protecting routes

```ts
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing bearer token'));
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired access token'));
  }
}
```
Standard Express middleware shape: runs before the actual route handler,
either calls `next()` to continue or `next(err)` to short-circuit into error
handling. `header?.startsWith('Bearer ')` — the standard HTTP convention for
sending a bearer token is `Authorization: Bearer <token>`. If present, strip
the `"Bearer "` prefix and hand the rest to `verifyAccessToken` (§7), which
throws for anything invalid/expired — caught here and turned into a clean
`401`. On success, `req.user` is populated so downstream handlers (like
`me`, §12) can trust `req.user.id` without re-verifying anything.

`AuthenticatedRequest extends Request { user?: {...} }` — a small TypeScript
extension of Express's `Request` type so `req.user` is a typed, known
property rather than requiring `any` casts everywhere it's used.

---

## 14. `src/middleware/error.middleware.ts` — one place all errors funnel through

```ts
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}
```
Registered *after* every real route (§16) — if nothing else matched, this
runs and turns it into a proper `AppError`, so even 404s get the same
consistent JSON error shape as everything else.

```ts
function asExposedHttpError(err: unknown): { statusCode: number; message: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const candidate = err as Error & { statusCode?: unknown; status?: unknown; expose?: unknown };
  if (candidate.expose !== true) return undefined;
  const statusCode =
    typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return undefined;
  return { statusCode, message: candidate.message };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { message: err.message } });
  }

  const exposedHttpError = asExposedHttpError(err);
  if (exposedHttpError) {
    return res.status(exposedHttpError.statusCode).json({
      error: { message: exposedHttpError.message },
    });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ error: { message: 'Internal server error' } });
}
```
Express identifies this as an **error-handling** middleware specifically
because it has **four parameters** (`err, req, res, next`) — that arity is
how Express distinguishes it from a normal middleware function; this is why
`_req` and `_next` are kept even though unused (renamed with a leading `_`
so the `noUnusedParameters` TypeScript check doesn't complain).

The first branch is the crucial security property of this whole file: known,
"expected" errors (`AppError` — wrong password, duplicate email, expired
token, ...) are shown to the client with their specific message. Anything
*else* — a bug, a database connection failure, an unexpected exception deep
in some library — is logged in full server-side (`console.error`, where a
real deploy would send it to a log aggregator/error tracker) but the client
only ever sees a generic `"Internal server error"`. This is what prevents,
say, a raw Postgres constraint-violation message (which can reveal schema
details) or a stack trace from ever reaching a client response.

**`asExposedHttpError` exists to close a gap the `AppError` check alone
misses.** Not every error this app can throw is one this codebase wrote:
`express.json()` (`app.ts`, §18) throws its own errors for things like a
body over `JSON_BODY_LIMIT` (`PayloadTooLargeError`, status `413`) or
malformed JSON (a `SyntaxError`, status `400`) — neither is an `AppError`
instance, so without this function, both fell through to the generic `500`
branch: correct in spirit (never crash), wrong in specifics (a client
sending too much data, or broken JSON, would see "Internal server error"
instead of a status telling them what was actually wrong — genuinely
confusing feedback for something that isn't a bug at all). The fix isn't to
special-case `PayloadTooLargeError` and `SyntaxError` by name, though —
those are just two examples of errors built on the `http-errors` package's
convention (used throughout the Express ecosystem, including by body-parser
internally): a plain `Error` carrying `.statusCode`/`.status` and an
`.expose` flag, where `expose: true` is that convention's own signal that
the message is safe to show a client (as opposed to a `5xx` where it isn't
— `http-errors` sets `expose: false` for those). `asExposedHttpError` reads
that same signal directly, so it correctly handles *any* well-behaved
middleware's exposed 4xx error, present or future, not just the two that
happened to get tested.

---

## 15. `src/middleware/validate.middleware.ts` — request validation

```ts
export function validate(schema: AnyZodObject) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!result.success) {
      const message = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return next(new AppError(400, message));
    }
    const data = result.data as { body?: unknown; query?: unknown; params?: unknown };
    req.body = data.body ?? req.body;
    if (data.query !== undefined) {
      req.query = data.query as Request['query'];
    }
    if (data.params !== undefined) {
      req.params = data.params as Request['params'];
    }
    next();
  };
}
```
A **middleware factory** — `validate(signupSchema)` returns an actual
middleware function closed over that specific schema, which is why routes
write `validate(signupSchema)` rather than `validate` — one function,
reused for every different shape of input. `safeParse` (rather than `parse`)
returns a result object instead of throwing, so this can convert a
validation failure into a clean `AppError(400, ...)` with a readable message
listing every field that failed and why, instead of a raw zod exception.

Writing the parsed result back onto `req` — not just `body`, but `query` and
`params` too — is what makes downstream code actually see zod's *output*
(trimmed strings, coerced numbers, whatever transforms a schema applies)
rather than the raw request. An earlier version of this function only wrote
back `req.body`, even though it validated `query`/`params` too (they're
right there in the object passed to `safeParse`) — every schema this app
currently defines only covers `body`, so that gap was never *observed*
(there was nothing for it to silently drop), but it was still real: the
moment any route added a schema with a `query` shape — pagination params, a
search filter, anything coerced like `page: z.coerce.number()` — that
route's `req.query` would keep the raw, unparsed strings, silently
contradicting what the schema claims to guarantee. `data.query !== undefined`
guards each write independently, since most schemas here still only define
`body` — for those, `result.data.query` is genuinely `undefined` (zod's
default behavior strips keys a schema doesn't define), and the corresponding
`if` simply never fires, leaving `req.query` exactly as Express gave it.

```ts
export const signupSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long'),
    name: z.string().trim().min(1).max(100).optional(),
  }),
});
```
Why `min(8)` and nothing about requiring uppercase/numbers/symbols: current
security guidance (NIST SP 800-63B) found that forced character-class rules
mostly push users toward predictable patterns (`Password1!`) rather than
actually stronger passwords, and recommends favoring length and checking
against known-breached password lists instead. This app doesn't implement a
breach-list check (that would mean shipping or calling out to a large
compromised-password database — a reasonable v2 addition, e.g. via the
HaveIBeenPwned API), but deliberately doesn't add the counterproductive
complexity rules either.

The `.max(72)`, though, isn't a complexity rule — it's a correctness fix, and
worth understanding why 72 specifically. bcrypt (the algorithm behind
`hashPassword`, §5) has a hard, well-known limitation: it only actually
hashes the first 72 *bytes* of its input and silently ignores anything past
that — it doesn't error, it just produces the same hash for
`"a".repeat(80)` as it would for `"a".repeat(72)`. Without this `.max()`,
that's directly exploitable in a narrow but real way: two *different*
passwords sharing the same first-72-bytes prefix would hash identically and
both authenticate successfully, meaning a "200-character password" someone
believes is very strong could, past its 72nd byte, be contributing nothing
to security at all. Capping input length at the API boundary makes that
truncation impossible to reach in the first place. (72 *characters*, not
bytes, so this is a conservative approximation, not an exact match to
bcrypt's real limit — a password using many multi-byte UTF-8 characters
could theoretically still exceed 72 bytes while under 72 characters. Good
enough to close the realistic case; see `README.md`'s security notes.)

---

## 16. `src/middleware/rateLimit.middleware.ts`

```ts
function makeLimiter(max: number) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many attempts, please try again later' } },
  });
}

export const strictAuthRateLimiter = makeLimiter(env.RATE_LIMIT_STRICT_MAX);
export const standardAuthRateLimiter = makeLimiter(env.RATE_LIMIT_STANDARD_MAX);
```
Two **separate** exported limiters, each its own call to `rateLimit(...)` —
this shape matters more than it looks like it should, and is worth
understanding precisely, because an earlier version of this file exported
one `authRateLimiter` (a single `rateLimit({...})` call) and attached that
*same instance* to every mutating route in `auth.routes.ts`
(`signup`/`login`/`refresh`/`logout`/`google/exchange`).

**Why that was a real bug, not just an odd choice.** `express-rate-limit`'s
counter store lives *inside* the middleware function `rateLimit(...)`
returns — it's not something Express creates fresh per route. Attaching the
same middleware *instance* to five different routes means all five draw
against the *same* counter, per client IP: not "20 signup attempts and,
separately, 20 login attempts," but "20 requests total, however they're
split across all five routes." Concretely — a burst of signups (bots, or
just a busy signup form) can exhaust the shared budget and lock *login* out
for a completely different, unrelated user behind the same IP, who never
attempted a signup at all — a real availability problem for anyone behind a
shared IP (a corporate NAT, a campus network, CGNAT), and it also weakens
the original brute-force protection the limiter existed for in the first
place, since an attacker could spend part of the budget on the cheaper
`/logout` or `/refresh` before ever touching `/login`.

The fix is exactly what `makeLimiter` being a *function* (rather than the
limiter being one hardcoded value) enables: `strictAuthRateLimiter` and
`standardAuthRateLimiter` are two independent calls to `rateLimit(...)`,
each getting its own separate counter store, tuned to two different budgets
via `env.RATE_LIMIT_STRICT_MAX`/`env.RATE_LIMIT_STANDARD_MAX` — `strict` for
`signup`/`login` (the genuine brute-force/credential-stuffing surface),
`standard` for `refresh`/`logout`/`google/exchange` (still worth bounding —
each one touches the database — but shouldn't compete with login's budget,
and realistically tolerates more traffic: a client legitimately refreshing
its access token every 15 minutes over a long session, for instance).
`windowMs`/the two max values are all read from `env` rather than hardcoded,
specifically so the numbers can be tuned to real traffic without a code
change — the values in an earlier version (a single hardcoded `limit: 20`)
had no such escape hatch.

---

## 17. `src/routes/auth.routes.ts` — wiring it all together

```ts
authRouter.post('/signup', strictAuthRateLimiter, validate(signupSchema), authController.signup);
authRouter.post('/login', strictAuthRateLimiter, validate(loginSchema), authController.login);
authRouter.post('/refresh', standardAuthRateLimiter, validate(refreshSchema), authController.refresh);
authRouter.post('/logout', standardAuthRateLimiter, validate(refreshSchema), authController.logout);
authRouter.get('/me', requireAuth, authController.me);

authRouter.get('/google', standardAuthRateLimiter, authController.googleRedirect);
authRouter.get('/google/callback', standardAuthRateLimiter, authController.googleCallback);
authRouter.post(
  '/google/exchange',
  standardAuthRateLimiter,
  validate(googleExchangeSchema),
  authController.googleExchange,
);
```
Express middleware runs left to right. For `POST /signup`: rate-limit check
first (cheapest, rejects abuse before doing any real work) → validate the
body shape → only then does the actual controller function run. `/me` runs
`requireAuth` first — if that calls `next(err)` instead of `next()`, the
controller function never executes at all.

Which route gets `strictAuthRateLimiter` vs. `standardAuthRateLimiter`
matches the split explained in §16: `signup`/`login` get the strict budget,
everything else that carries a limiter shares the standard one — genuinely
separate counters, not the same limiter instance reused across every route.
`/logout` carries a limiter at all (rather than none) for a reason worth
restating here: it's a mutation that touches the database
(`prisma.refreshToken.updateMany`) on every call, so leaving it completely
unbounded would still be a real (if narrow) abuse surface — it just doesn't
need to share login's stricter budget to be reasonably protected.

Both Google `GET` routes now carry `standardAuthRateLimiter` too — an
earlier version left them unlimited entirely. `/google` looks cheap (it
just sets a cookie and redirects), but "cheap enough to not bother limiting"
and "actually unlimited" are different claims, and only the first one was
ever true; `/google/callback` does real, non-trivial work per call — a
network round trip to Google to exchange the authorization code, an ID-token
signature verification, a database read (and sometimes a write) — none of
which should be reachable at unlimited volume just because the route
happens to be a `GET` driven by a redirect rather than a `POST` a client
calls directly.

---

## 18. `src/app.ts` — assembling the Express app

```ts
function corsOrigin(): boolean | string[] {
  if (env.CORS_ALLOWED_ORIGINS) {
    // Already parsed AND validated into a clean string[] by env.ts's zod
    // schema (§3) — empty/malformed origins are rejected there, at boot, so
    // there's nothing left to re-parse or re-check here.
    return env.CORS_ALLOWED_ORIGINS;
  }
  return env.ALLOW_ANY_CORS_ORIGIN;
}
```
`corsOrigin()` decides which origins may call this API from a browser, and
it's been through two prior versions worth knowing about, because each
fixed a real (not theoretical) gap the previous one had.

- **Version 1**: just `cors()`, no arguments — the library's own default,
  `Access-Control-Allow-Origin: *`, reflecting literally any origin on every
  route, with no way to narrow it short of editing code. Any website,
  anywhere, could have a visiting browser make fetch calls to this API and
  read the JSON responses — the browser's Same-Origin Policy is exactly what
  CORS headers override, and `*` opts out of that protection entirely, for
  every caller, unconditionally.
- **Version 2**: `env.NODE_ENV === 'production' ? false : true` — closed in
  production, open (reflect-any-origin) everywhere else. Better, but still
  broken in a specific way: `NODE_ENV` (`config/env.ts`, §3) *defaults* to
  `'development'` when unset. A real deployment that simply forgot to set
  `NODE_ENV` — not a contrived scenario; it's an easy thing to miss in a
  hosting platform's config — would silently land in the open branch,
  exactly the failure this was supposed to prevent, just one layer removed.
- **Current version**, shown above: `env.ALLOW_ANY_CORS_ORIGIN`, a
  *dedicated* flag (§3) that defaults to `false` with no such escape hatch —
  it's never inferred from anything else, so there's no other setting whose
  default value can accidentally make this permissive. Being open now
  requires setting `ALLOW_ANY_CORS_ORIGIN=true` on purpose, in every
  environment including local dev (see `.env.example`).

```ts
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function createApp() {
  const app = express();

  if (env.TRUST_PROXY !== undefined) {
    app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  }

  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
  app.use(cors({ origin: corsOrigin() }));
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser(env.COOKIE_SECRET));

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
```
Order matters throughout:
- **`app.set('trust proxy', ...)`**, first, before any middleware — only
  when `TRUST_PROXY` is set at all (left alone otherwise, which is Express's
  own default: proxy trust disabled, correct for a direct-connection local
  setup). This setting controls where Express thinks a request's real IP
  comes from. Running behind any reverse proxy or load balancer (nginx, an
  ALB, Cloudflare, …) without it means every request's `req.ip` resolves to
  the *proxy's* IP, not the actual client's — and since `req.ip` is exactly
  what `rateLimit.middleware.ts` (§16) keys its per-client counters on, that
  silently turns "20 attempts per client" into "20 attempts for every client
  behind the proxy, combined." (`express-rate-limit` itself also actively
  guards against the specific danger of trusting a spoofable
  `X-Forwarded-For` header when it hasn't been told to — which is the flip
  side of the same coin: getting `TRUST_PROXY` wrong in *either* direction
  is a real problem, not just a style nit.) `parseTrustProxy` converts the
  env string into whatever shape Express's setting actually wants — a
  boolean, a hop count (`"1"` → `1`), or passed through as-is for a preset
  keyword like `"loopback"` or an IP/CIDR list.
- `helmet()` — sets a batch of security-related HTTP response headers
  (`X-Content-Type-Options`, a conservative default CSP, etc.) — applied
  early so it covers every response, including error responses.
- The small inline middleware right after it sets two more headers `helmet()`
  doesn't (and structurally can't) set on its own, because `helmet` is
  generic — it has no way to know this specific API's responses carry
  access/refresh tokens and user data:
  - `Cache-Control: no-store` — tells browsers *and* any intermediate
    cache/proxy sitting between the client and this server "never store
    this response, full stop." Without it, a shared/corporate proxy, or
    just the browser's own disk cache, could retain a response that
    contains a freshly-issued access or refresh token.
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
    — this is a JSON API with no UI of its own; it has no legitimate reason
    to ever invoke a browser's camera, microphone, geolocation, or
    payment-handling APIs. Explicitly disabling them is defense-in-depth:
    a no-op for any well-behaved client, but it closes those APIs off for
    good in case a response from this server ever ends up rendered
    somewhere that could otherwise invoke them (a misconfigured client, a
    future bug, browser dev tools rendering a response directly).
  Applied to *every* response (including `/health`) rather than scoped to
  just `/api/auth/*`, since there's no response from this server that should
  ever be cached or should ever need those browser features.
- `cors({ origin: corsOrigin() })` — see above.
- `express.json({ limit: env.JSON_BODY_LIMIT })` — parses `application/json`
  request bodies into `req.body`; without this middleware at all,
  `req.body` would be `undefined` and every `validate(...)` call would fail.
  The explicit `limit` (an earlier version omitted it, silently relying on
  body-parser's own unmentioned 100kb default) matters for two reasons: it's
  self-documenting — a reader doesn't have to already know body-parser's
  default to understand what's allowed — and it lets this specific API (a
  handful of short string fields, no file uploads) bound the limit tighter
  than a one-size-fits-all default, so an oversized body gets rejected
  before it's ever fully buffered into memory. See `error.middleware.ts`
  (§14) for how the resulting `PayloadTooLargeError` becomes a proper `413`
  instead of a generic `500`.
- `cookieParser(env.COOKIE_SECRET)` — parses the `Cookie` header into
  `req.cookies` (unsigned) and `req.signedCookies` (verified against
  `COOKIE_SECRET`) — this second one is what `googleCallback` reads to check
  the OAuth `state` cookie.
- **Why it's a function (`createApp()`) rather than the app built at module
  scope**: this lets tests call `createApp()` to get a fresh Express app
  wired to (mocked) dependencies, without that app auto-starting a server —
  separating "build the app" from "listen on a port" (that's `server.ts`,
  next).
- `notFoundHandler` / `errorHandler` are registered **last** — Express tries
  routes in registration order, so anything not matched by `/health` or
  `/api/auth/*` falls through to `notFoundHandler`, and any error thrown
  anywhere earlier (via `next(err)`) skips straight to `errorHandler`
  regardless of where in between it was thrown.

---

## 19. `src/server.ts` — actually starting the process

```ts
const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`auth-service listening on port ${env.PORT} (${env.NODE_ENV})`);
});
```
The only file that calls `.listen(...)` — kept separate from `app.ts`
specifically so tests (`supertest(app)`) can exercise the whole HTTP stack
in-process, without binding a real port at all. Capturing the return value
as `server` (an earlier version discarded it) is what makes everything
below possible — both the error handler and the graceful shutdown need a
handle on the actual HTTP server object, not just the Express app.

```ts
server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```
Without this, a startup failure — most commonly `EADDRINUSE`, the port
already being in use — surfaces as an **unhandled** `'error'` event on the
server object. In Node, an unhandled `'error'` event on an `EventEmitter`
throws, which for a bare `app.listen(...)` with nothing listening for it
means a confusing, generic crash instead of a clear "here's what actually
went wrong" message. This turns that into an intentional, informative exit.

```ts
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} received, shutting down gracefully...`);

  server.close(async (closeErr) => {
    if (closeErr) console.error('Error while closing HTTP server:', closeErr);
    await prisma.$disconnect();
    process.exit(closeErr ? 1 : 0);
  });

  setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```
Without any of this, the *default* behavior of a Node process receiving
`SIGTERM` — the signal a container orchestrator (Docker, Kubernetes, most
PaaS platforms) sends to ask a process to stop, before escalating to
`SIGKILL` if it doesn't — is to terminate immediately. Every request the
process happens to be in the middle of handling at that exact moment is cut
off mid-flight, and the database connection is torn down uncleanly rather
than closed. This function makes shutdown a deliberate, ordered sequence
instead:

- `shuttingDown` guards against handling the same shutdown twice — `SIGTERM`
  and `SIGINT` could both arrive (or the same signal twice, from an
  impatient `Ctrl+C`), and re-entering this logic a second time while the
  first call is still in flight would be at best redundant, at worst race
  the first call's own cleanup.
- `server.close(callback)` — tells the HTTP server to stop accepting *new*
  connections, but **its callback only fires once every in-flight request
  has finished** — that's the actual mechanism behind "graceful": no request
  gets cut off, the process just stops handing out new ones.
- Only once `close` completes does it `await prisma.$disconnect()` —
  closing the database connection pool cleanly, rather than however it would
  end up if the process just vanished mid-query.
- `process.exit(closeErr ? 1 : 0)` — a clean exit code signals to whatever's
  supervising this process (systemd, Kubernetes, …) whether shutdown
  actually succeeded.
- The `setTimeout(..., 10_000).unref()` is a backstop for the one case the
  graceful path doesn't handle on its own: something (a request stuck
  waiting on a hung downstream call, say) keeps `server.close`'s callback
  from ever firing. Without this, the process would simply hang forever
  instead of eventually exiting. `.unref()` tells Node not to let this timer
  by itself keep the process alive — if everything else finishes cleanly
  first, this timer doesn't block the process from exiting on its own.

---

## 20. Tests

### `tests/setup.ts` (`jest.config.js` → `setupFiles`)

Runs once, before any test file, and populates `process.env` with dummy-but-
valid values for every field `env.ts`'s zod schema requires. Without this,
the *first* test file to import anything that transitively imports
`config/env.ts` would crash the whole suite with a zod validation error.

### `tests/mocks/prisma.mock.ts` — mocking the database

```ts
jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  prisma: mockDeep<PrismaClient>(),
}));

const { prisma } = require('../../src/lib/prisma') as { prisma: PrismaClient };
export const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
});
```
`jest.mock(path, factory)` tells Jest: "whenever any file (anywhere in this
test run) does `import ... from '../../src/lib/prisma'`, give it this fake
object instead of actually running `prisma.ts`." `mockDeep<PrismaClient>()`
(from `jest-mock-extended`) auto-generates a fake with every single Prisma
method (`user.findUnique`, `user.create`, `refreshToken.create`, ...)
replaced by a Jest mock function, recursively, matching Prisma's real typed
shape — so `prismaMock.user.findUnique.mockResolvedValue(someUser)` is fully
type-checked against Prisma's real signatures.

The `require(...)` **after** the `jest.mock(...)` call (rather than a normal
`import` at the top) is deliberate, not stylistic: it guarantees the mock is
registered before anything asks for the real module, regardless of any
subtlety in how the TypeScript-to-CommonJS compiler orders `import`
statements relative to other top-level code (`ts-jest` doesn't apply the
same "hoist `jest.mock` above imports" transform that `babel-jest` does) —
using a plain function call sidesteps that question entirely.

`beforeEach(() => mockReset(prismaMock))` — resets every mocked method
between tests, so `mockResolvedValue(...)` set in one test can't leak into
the next.

Every unit/integration test that touches the database starts with
`import { prismaMock } from '../mocks/prisma.mock';` — that one import line
is what activates the mock for that entire test file (Jest mocks are
file-scoped).

### `tests/unit/password.test.ts`
Confirms: hashing doesn't return the plaintext back; hashing the same
password twice gives different output (proves salting is happening);
`comparePassword` returns `true`/`false` correctly for right/wrong input.

### `tests/unit/jwt.test.ts`
Confirms: sign→verify round-trips to the same `sub`/`email` **plus** a
genuine `jti` (asserted to be a non-empty string, §7) — using `toMatchObject`
rather than `toEqual` specifically because the exact payload now legitimately
has more in it than just what was passed in; a second test confirms two
separately-signed tokens for the same user get *different* `jti` values,
locking in that it identifies the token, not the user. A token signed with a
*different* secret is rejected (proves signature checking actually works,
not just structural parsing); an already-expired token is rejected with the
specific `TokenExpiredError`; a token missing the `email` claim is rejected
even though its signature is otherwise valid; and two regression tests for
`issuer`/`audience` — a correctly-signed token with the *wrong* `audience`,
and separately one with the wrong `issuer`, are both rejected even though
nothing else about them is invalid, proving `verifyAccessToken` actually
enforces those claims rather than merely accepting whatever (or no) value
shows up.

### `tests/unit/token.service.test.ts`
The most involved test file, matching the most involved source file:
- `issueTokenPair`: asserts the returned access token verifies correctly,
  the refresh token is 96 hex chars, and — critically — that what got
  written to the mocked `prisma.refreshToken.create` call is **not** equal
  to the raw refresh token handed back to the caller (proving the hash, not
  the raw value, is what's persisted).
- `rotateRefreshToken`: one test per branch of the function — unknown token
  → rejected; already-revoked token → rejected *and* asserts
  `updateMany` was called with `{ userId, revokedAt: null }` (the mass
  revocation on reuse-detection); expired token → rejected; a valid token →
  claims it via the conditional `updateMany({ where: { id, revokedAt: null } })`
  and returns a new pair; and — the regression test for the race condition
  described in §9 — a **lost claim** (`updateMany` mocked to return
  `{ count: 0 }`, simulating a concurrent caller winning the race first) is
  asserted to be treated exactly like the already-revoked branch: rejected
  with the same `401`, `refreshToken.create` never called, and the mass
  revoke-for-user fired. Testing `prisma.$transaction`'s interactive form
  here means mocking it to actually *invoke* its callback
  (`prismaMock.$transaction.mockImplementation((cb) => cb(prismaMock))`,
  passing `prismaMock` itself as the stand-in for `tx`) rather than just
  resolving a value, since the function under test relies on that callback
  actually running to reach the `updateMany`/`create` calls being asserted on.
- `revokeRefreshToken`: asserts the `updateMany` call's `where`/`data`
  shape matches what logout is supposed to do.
- The `isActive` regression test: a stored token whose `user.isActive` is
  `false` is rejected with the specific "no longer active" message, **and**
  asserts `prisma.$transaction` was never even called — proving the check
  short-circuits before any rotation work happens, not after.

### `tests/unit/oauthHandoff.service.test.ts`
Direct tests for the handoff store (§11a), separate from the OAuth flow
that normally drives it: round-trips a stashed user/tokens pair through its
code; confirms it's genuinely single-use (a second `consumeHandoff` of the
same code returns `undefined`); rejects a code that was never issued; and —
using `jest.useFakeTimers()` to fast-forward past the 60-second TTL without
an actual 60-second test — confirms an expired code is rejected even on its
first-ever consume attempt. A final test covers the configurable-cap
behavior (§11a): using `withFreshEnv` (see the tests-helper section below)
to require a fresh copy of the module with `OAUTH_HANDOFF_MAX_ENTRIES` set
to a small `'3'` (rather than waiting on the real default of 5000), it
creates exactly three handoffs, confirms `console.error` (spied via
`jest.spyOn`) hasn't fired yet — right at the cap, not over it — then
asserts a 4th `createHandoff` call throws the specific `AppError(503, ...)`
and that the error was logged exactly once. Critically, the test then
`consumeHandoff`s all three *original* codes and asserts every one of them
is still perfectly valid — this is the direct regression test for the
reject-vs-evict fix: an earlier version of this function evicted the oldest
of those three to make room for a 4th, which would have failed this exact
assertion.

### `tests/unit/auth.service.test.ts`
Mocks `token.service` itself at the module level
(`jest.mock('../../src/services/token.service', ...)`) so these tests are
purely about signup/login *logic*, not re-testing token issuance (already
covered above) — a good example of testing one unit at a time rather than
re-verifying the same behavior in every file that happens to call it.
Confirms: duplicate email (caught by the fast-path `findUnique` check) →
`409`; a successful signup normalizes the email (trims/lowercases) and never
writes/returns the plaintext password; login against a nonexistent account,
a Google-only account (no password), and a wrong password *all* produce the
exact same `401` message (locking in the enumeration-resistance property
described in §10); a correct login returns the user and tokens. Two more
tests exercise the race-condition fix specifically: `findUnique` mocked to
report "no existing user" while `prisma.user.create` is mocked to *reject*
with a real `Prisma.PrismaClientKnownRequestError` (`code: 'P2002'`,
constructed the same way Prisma itself would throw it) — simulating the
fast-path check missing a real concurrent duplicate — asserts the result is
still a clean `409`, not a `500`; a companion test rejects `create` with a
plain, unrelated `Error` and asserts that one is genuinely re-thrown as-is,
proving the `catch` block only special-cases `P2002` and doesn't swallow or
mislabel other database failures. A dedicated test also confirms a disabled
account (`isActive: false`) is rejected with the same generic message as
everything else, and — using `jest.spyOn(passwordUtils, 'comparePassword')`
— that `comparePassword` is never even called for it, proving the `isActive`
check really does run before the password comparison, not just before the
tokens get issued.

A whole nested `describe('account lockout', ...)` block covers the lockout
mechanism in `login()` (§10) on its own:
- A wrong password with some prior failures increments
  `failedLoginAttempts` by exactly one and leaves `lockedUntil: null` —
  asserting the *exact* `prisma.user.update` call shape, not just that
  *an* update happened, catches an off-by-one as readily as a missing call.
- Reaching `env.LOCKOUT_MAX_ATTEMPTS` on a wrong password sets
  `lockedUntil` to a real future `Date`, checked with a range assertion
  (`getTime()` between "now" and "now + LOCKOUT_DURATION_MS + a second of
  slack for test execution time") rather than an exact timestamp, since the
  function computes `Date.now()` internally at call time — an exact-match
  assertion would be flaky by construction.
- A currently-locked account rejects even the **correct** password —
  deliberately used in this test, not a wrong one, to prove the lock itself
  is what's blocking access, not incidentally a bad password — and, using
  the same `comparePassword` spy technique as the disabled-account test
  above, confirms it's rejected *before* the password is ever compared, and
  that no database write happens for an attempt that never got that far.
- Feeding in a user whose `failedLoginAttempts` is at the limit but whose
  `lockedUntil` is a timestamp in the *past* (an expired lock) and supplying
  a wrong password again confirms the count resets to `1`, not
  `LOCKOUT_MAX_ATTEMPTS + 1` — the direct regression test for the "expired
  lock gets a fresh budget, not an instant re-lock" logic explained in §10.
- A successful login after prior failures asserts the exact
  `{ failedLoginAttempts: 0, lockedUntil: null }` reset call; a companion
  test with a *clean* history (zero prior attempts) asserts `update` is
  **not** called at all, locking in the "don't write to the database when
  there's nothing to reset" optimization.
- A final test confirms lockout bookkeeping is untouched entirely for both
  a nonexistent account and a Google-only one — there's no row to track
  attempts against in the first case, and no password to have been guessed
  wrong in a way lockout should care about in the second.

### `tests/unit/google.service.test.ts`
Covers all three branches of `findOrCreateGoogleUser` from §11: already
linked → returned as-is, `findFirst` called exactly once (locking in the
single-round-trip fix — the earlier two-`findUnique`-calls version would
still have passed a test asserting the *result*, so this explicitly checks
the call count too); matching email + verified → linked via `update`;
matching email + **not** verified → rejected, `update` never called (the
account-takeover guard, explicitly tested); no match at all → `create`
called with `passwordHash: null`. Two more tests mirror the pair in
`auth.service.test.ts` for the concurrent-signup race (§11): `create`
mocked to reject with a real `P2002` error, `findFirst` mocked to return a
"winner" on its *second* call (the re-fetch after losing the race) —
asserts the function returns that winner rather than throwing, and that
`findFirst` really was called exactly twice; a companion test confirms an
unrelated `Error` from `create` is re-thrown as-is, not misreported as a race.
Two more tests cover the equivalent race on the `update()`/linking path
(§11): one where the re-fetch-by-`googleId` after a `P2002` finds a row with
the **same** email as the one being linked — asserts the function returns
that row (the benign-race outcome), and that the re-fetch used
`prisma.user.findUnique({ where: { googleId } })` specifically; a second
where the re-fetch finds a row with a **different** email — asserts a
distinct `409 "already linked to a different user"` is thrown instead,
proving the genuine-conflict branch doesn't get collapsed into the
benign-race one just because both start from the same `P2002`.

### `tests/unit/validate.middleware.test.ts`
Didn't exist before this round of fixes. Confirms the core behavior (an
invalid body → `400` `AppError`; a valid body → `req.body` replaced with
zod's parsed/transformed output, e.g. a trimmed+lowercased email) and,
specifically, the query/params write-back fix (§15): a custom schema that
validates `query` (with a `z.coerce.number()` field) has its *parsed*
`req.query` — not the raw request's — visible to whatever runs next; a
schema that only defines `body` leaves `req.query` completely untouched
(asserted via `toBe`, object identity, not just `toEqual`) — proving the
new write-back code doesn't overwrite `req.query` with `undefined` when a
schema simply has nothing to say about it.

### `tests/unit/error.middleware.test.ts`
Also didn't exist before this round. Confirms: an `AppError` passes its
`statusCode`/message through unchanged; a hand-built object shaped exactly
like what body-parser actually throws (`Error` + `.statusCode` + `.expose:
true`, §14) is translated to its real status and message — the regression
test for the body-size-limit/malformed-JSON fix; a same-shaped error but
with `expose: false` is *not* treated the same way — falls back to the
generic `500`, proving `asExposedHttpError` respects that flag rather than
just checking "does this have a `statusCode`"; a plain unexpected `Error` (a
deliberately sensitive message) results in a `500` whose response body does
**not** contain that message, confirming nothing unexpected ever leaks to
the client; and a thrown non-`Error` value (a plain string) is also handled
without crashing the handler itself.

### `tests/integration/rateLimit.test.ts`
A dedicated file, not folded into `auth.routes.test.ts` — deliberately, so
it gets its own fresh module registry and therefore fresh, unused
`strictAuthRateLimiter`/`standardAuthRateLimiter` counters (§16), unaffected
by any earlier test in a shared file having already spent part of either
budget. This is the direct regression test for the shared-rate-limit-budget
bug: drives 31 requests into `/login` — one past `RATE_LIMIT_STRICT_MAX`'s
default of 30 — confirms the last one gets `429`, then makes a *single*
request to `/refresh` and asserts it comes back `401` (a real, normal
response), not `429`. An earlier version of the rate limiter, reused across
every route, would have failed that last assertion — `/refresh` would have
inherited `/login`'s exhausted budget.

### `tests/helpers/freshEnv.ts`
Not a test file itself — a shared helper (`withFreshEnv`), extracted out of
what was originally `corsConfig.test.ts`'s own local function once
`envValidation.test.ts` needed the exact same capability: given some env var
overrides, seed a full set of required values, run a callback inside
`jest.isolateModules(...)` (so any `require(...)` inside it resolves against
a genuinely fresh module registry, picking up a freshly-parsed `env.ts`),
then restore `process.env` afterward. See the note on `corsConfig.test.ts`
below for *why* this level of isolation is necessary at all, not just
convenient.

**This helper had a real bug, worth explaining precisely because of how it
manifested.** The restore step —
`process.env = savedEnv;` — originally ran as a plain statement after
`jest.isolateModules(...)`, not in a `finally`. That's fine as long as
`run()` returns normally. It is **not** fine for exactly the tests this
helper exists to support: every "rejects a bad value" test in this suite
calls `withFreshEnv(...)` specifically expecting the callback to throw
(`expect(() => withFreshEnv(...)).toThrow()`). When it does, the exception
unwinds straight out of `withFreshEnv` itself, skipping the restore line
entirely — leaving `process.env` permanently holding that call's overrides
for every test that ran *after* it in the same file. The failure this
produced was genuinely confusing to chase down: a later, entirely correct
test — say, one asserting a *valid* `CORS_ALLOWED_ORIGINS` value parses
correctly — would fail not because of anything wrong with its own
assertion, but because `process.env` already had a stray, invalid value
left over from an unrelated "rejects ..." test earlier in the file, which
that later test's own `Object.assign(process.env, REQUIRED_ENV, overrides)`
never fully overwrote (`Object.assign` only touches the keys present in
*that* call's overrides, not leftovers from a previous one). The fix is a
one-line change — wrap the restore in `try { ... } finally { process.env =
savedEnv; }` — but the *lesson* is the more general one: any test helper
that mutates shared, global state (here, `process.env`) and restores it
"when we're done" has to define "done" as "even if it threw," or it isn't
actually isolating anything for exactly the negative-path tests that matter
most.

### `tests/helpers/freshEnv.test.ts`
A direct regression test for the helper itself, not just trust that every
test *using* it happens to look right — added once the bug described above
was found and fixed. Confirms `process.env` is restored after a normal
call; confirms it's restored even when the callback throws (the actual
regression test — asserted with a matching `before`/`after` snapshot of one
specific variable, not just "the test suite as a whole didn't fail" which
is exactly the kind of thing that could pass for the wrong reason); and
confirms a variable explicitly overridden to `undefined` is genuinely
deleted during the call and correctly restored to its real prior value
afterward, not left as `undefined` permanently.

### `tests/unit/envValidation.test.ts`
Covers the `JWT_ACCESS_TTL` positivity check (§3) via `withFreshEnv`: a
normal value like `"15m"` is accepted and passed through unchanged;
`it.each(['0', '0s', '0m', '0.0h', '0d'])` drives the same assertion
("this must throw") across five different zero-duration spellings in one
parameterized test, rather than five near-identical `it` blocks, since the
point being proven — the `.refine()` catches *any* shape of zero, not one
specific string — is the same for every case; a plain garbage value
(`"banana"`) still fails the original format regex, confirming that check
wasn't accidentally weakened; and `"0.5h"` (a fractional value that
resolves to a nonzero duration) is accepted, confirming the new check isn't
overly broad and rejecting legitimate fractional TTLs along with the zero
ones.

### `tests/unit/email.test.ts`
Direct tests for `normalizeEmail` (§10) that didn't have their own file
before this round — trim + lowercase is confirmed as before, but the
Unicode-normalization regression test is the one worth reading closely: it
builds an NFC-encoded "é" and an NFD-encoded "é" with `String.fromCodePoint`
from explicit hex codepoints (`0x00e9` vs. `0x0065, 0x0301`) rather than
typing the accented character directly into the source file. That's not
paranoia for its own sake — it's a real risk specific to *this* test: typing
a literal accented character can get silently normalized by an editor, a
save pipeline, or even this very authoring session's own tools, at which
point both "different" strings in the test would already be identical
before `normalizeEmail` ever ran, and the test would pass for the wrong
reason (or rather, for no reason) regardless of whether the function under
test actually normalizes anything. Building both forms programmatically at
runtime sidesteps that risk entirely. The test then asserts the two raw
strings are provably different (different `.length`, not just `!==`, which
Unicode-normalized-vs-not strings can sometimes share) before confirming
`normalizeEmail` collapses them to the same output. A final test confirms
idempotence — normalizing an already-normalized email is a no-op.

### `tests/unit/corsConfig.test.ts`
One of the files that needs true module-level isolation to test at all,
because `env.ts` parses `process.env` exactly once, at import time —
proving "this exact `process.env` produces this exact behavior" means
starting from a genuinely fresh module registry per case
(`jest.isolateModules(...)`, via the shared `withFreshEnv` helper above),
not just reassigning `process.env` after `env.ts` has already run once and
cached its answer. Three groups:
- **`ALLOW_ANY_CORS_ORIGIN` parsing** — `"false"` parses to real `false`
  (the direct regression test for the `z.coerce.boolean()` footgun
  described in §3 — asserted with `toBe(false)`, not a looser truthy check,
  specifically because the bug this guards against would make it `true`);
  `"true"` parses to `true`; unset defaults to `false`; a nonsense value
  (`"yes-please"`) is rejected outright rather than silently defaulting.
- **`CORS_ALLOWED_ORIGINS` parsing/validation** (§3) — a single valid origin
  parses to a one-element array; multiple comma-separated origins are
  trimmed and parsed correctly; unset stays `undefined` (so `corsOrigin()`
  falls through to `ALLOW_ANY_CORS_ORIGIN`); `it.each(['', ',', ' , , ', ' '])`
  drives the "empty/comma-only value is rejected" assertion across four
  different ways of writing "nothing usable," in one parameterized test;
  an origin with a trailing slash, one with a path, and one missing a
  scheme entirely are each rejected individually; and a final test confirms
  that even one malformed origin in an otherwise-valid comma-separated list
  fails the *whole* value, rather than silently dropping just the bad entry.
- **CORS actually stays closed** — the scenario from the originally reported
  bug, reproduced directly: `NODE_ENV` entirely unset, no `CORS_ALLOWED_ORIGINS`,
  no `ALLOW_ANY_CORS_ORIGIN` → a real preflight `OPTIONS` request against a
  freshly-built app has **no** `Access-Control-Allow-Origin` header at all.
  A second test confirms the escape hatch itself works: the same setup with
  `ALLOW_ANY_CORS_ORIGIN=true` gets the header, reflecting the request's
  origin.

### `tests/unit/auth.middleware.test.ts`
Builds fake Express `req`/`res`/`next` objects by hand (no need for a real
HTTP server to test a middleware function — it's just a plain function).
Confirms: no header → `401`; non-Bearer header → `401`; garbage token →
`401`; a real, validly-signed token → `next()` called with **no** arguments
(the Express convention for "continue, no error") and `req.user` populated
with the correct `id`/`email`.

### `tests/integration/auth.routes.test.ts`
Uses `supertest(app)` to send real HTTP requests into the actual Express app
(`createApp()`) — routing, middleware order, validation, and JSON
serialization are all exercised for real; only the database is mocked.
Confirms, end-to-end through the HTTP layer: invalid email/short password →
`400` with a validation message; a password over 72 characters → `400`; a
full valid signup → `201`, and the response JSON genuinely has no
`passwordHash` field anywhere in it; duplicate email (via the fast-path
check) → `409`; duplicate email caught only by the database's own unique
constraint (a mocked `P2002` from `create`, same as the service-level test
above but exercised through the full HTTP stack) → `409`, not `500`; login
against a nonexistent account → `401`; `/me` with no auth header → `401`.

`/me` also gets two more targeted tests once `isActive` entered the
picture (§12): a real, validly-signed access token (via `signAccessToken`,
same as `auth.middleware.ts` would produce) for a user whose mocked
`prisma.user.findUnique` returns `isActive: false` gets `403`; the same
setup with `isActive: true` gets `200` with the expected user back — proving
the check actually branches both ways, not just that it exists.

`GET /auth/google` → a real `302` redirect whose `Location` header points at
`accounts.google.com`, with the `oauth_state` cookie actually set on the
response — plus a dedicated test confirming a `ratelimit-limit` response
header is present at all (the regression test for the "Google routes had no
rate limiting" fix, §17), and the same header check repeated for `GET
/auth/google/callback`. A further `google/callback` test drives a rejected
callback (mismatched `state`) and inspects the actual `Set-Cookie` header
Express sent for clearing `oauth_state` — asserting it contains both
`HttpOnly` and `SameSite=Lax`, not just that *a* clearing cookie was sent —
the direct regression test for the cookie-options-mismatch fix (§12): before
that fix, this exact assertion would have failed, because the clearing call
carried no attributes at all.

`POST /auth/google/exchange` → an unknown code rejected with `400`, and a
code obtained by calling `createHandoff` directly (standing in for what
`googleCallback` would have done) successfully exchanged once and rejected
the second time it's tried — proving the single-use property holds through
the actual route, not just the service function in isolation.

A `describe('hardened response headers', ...)` block hits a plain `GET
/health` and asserts `Cache-Control: no-store` is present exactly, and that
`Permissions-Policy` contains `camera=()`, `microphone=()`, and
`geolocation=()` — the regression test for §18's added headers, deliberately
run against the *least* auth-specific route in the app, to confirm the
headers apply globally rather than being scoped only to `/api/auth/*`.

A body over `JSON_BODY_LIMIT` → `413`, and malformed JSON → `400` — both the
direct regression test for the `error.middleware.ts` fix (§14): before that
fix, both of these came back a generic `500`; any unrecognized route → a
clean `404` JSON error (proving `notFoundHandler` is wired in correctly).

---

## Request lifecycle, start to finish (signup example)

To tie it all together, here's literally everything that happens for one
`POST /api/auth/signup` call, in order:

1. `server.ts`'s `app.listen(...)` has an Express app (`app.ts`) listening
   (with `trust proxy` set first, if `TRUST_PROXY` is configured).
2. Request hits `helmet()` → `cors({ origin: corsOrigin() })` →
   `express.json({ limit: env.JSON_BODY_LIMIT })` (parses the JSON body into
   `req.body`, or throws a `413`/`400` for an oversized/malformed one — see
   `error.middleware.ts`, §14) → `cookieParser()`.
3. Express matches `/api/auth/*` → into `auth.routes.ts`.
4. `strictAuthRateLimiter` — allowed to proceed (under its own, separate
   budget from `refresh`/`logout`/`google/exchange`'s `standardAuthRateLimiter`).
5. `validate(signupSchema)` — checks `req.body.{email,password,name}`
   (password length now bounded on both ends, 8–72); if invalid, responds
   `400` immediately and nothing further runs.
6. `authController.signup` — calls `authService.signup(req.body)`.
7. Inside `auth.service.ts`: normalize email → `prisma.user.findUnique` (a
   real Postgres query, the fast-path duplicate check) → if found, throw
   `AppError(409, ...)` → otherwise `hashPassword` (bcrypt, ~50-100ms) →
   `prisma.user.create` (real `INSERT`, wrapped in a `try`/`catch` that
   turns a `P2002` unique-constraint violation — the race the fast-path
   check can't fully close — into that same `409` rather than a `500`) →
   `issueTokenPair(user)`.
8. Inside `token.service.ts`: `signAccessToken` (sync, instant) +
   `generateRawRefreshToken` + `prisma.refreshToken.create` (another real
   `INSERT`, storing only the hash).
9. Back in the controller: `res.status(201).json({ user: toPublicUser(user), tokens })`.
10. If *any* step from 6-9 threw (duplicate email, DB connection failure,
    anything), it's caught by the controller's `try/catch`, passed to
    `next(err)`, and lands in `errorHandler` (§14), which either returns the
    specific `AppError` message or a generic `500` for anything unexpected.

That's the entire system — every other flow (login, refresh, Google OAuth)
follows the same shape: middleware → validate → service (the real logic,
talking to Prisma) → controller shapes the HTTP response → errors funnel to
one place.

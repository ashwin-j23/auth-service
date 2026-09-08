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
    .default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),
  OAUTH_SUCCESS_REDIRECT_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
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
- `CORS_ALLOWED_ORIGINS` is `.optional()` on purpose (see `app.ts`, §18) —
  its *absence* means something different depending on `NODE_ENV`, so it
  can't just have a hardcoded default here.
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
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
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

```ts
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === 'string' || !decoded.sub || !decoded.email) {
    throw new jwt.JsonWebTokenError('Malformed access token payload');
  }
  return { sub: decoded.sub, email: decoded.email as string };
}
```
- `jwt.verify` recomputes the HMAC signature using the same secret and
  compares it to the one embedded in the token; **throws** (doesn't return a
  falsy value) if the signature doesn't match, the token is expired, or it's
  malformed. This is why the caller (`auth.middleware.ts`) wraps this in
  `try/catch`.
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
```
Straightforward expiry check, separate from the revoked check above so the
error message is accurate (a stale-but-never-used token isn't "reused," it's
just old).

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
  return email.trim().toLowerCase();
}
```
`Jane@Example.com`, ` jane@example.com`, and `jane@example.com` should all be
the *same* account. Normalizing before every lookup/insert means the `@unique`
constraint on `email` in the schema actually behaves the way a user expects.
This function lives in its own `src/utils/email.ts` (not duplicated locally)
specifically because `google.service.ts` needs the exact same normalization —
if the two files each implemented "trim + lowercase" independently, a future
tweak to one (say, adding Unicode normalization for lookalike characters)
applied to only one of them would make the two files disagree about what
"the same email" means, and the Google-account-linking logic in
`google.service.ts` (§11) depends entirely on that agreement to work.

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

  const passwordMatches = await comparePassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  const tokens = await issueTokenPair(user);
  return { user: toPublicUser(user), tokens };
}
```
The important design decision here: **three different failure conditions —
no such account, account exists but has no password (Google-only), account
exists but the password is wrong — all throw the exact same error message**
(`invalidCredentials()`). This is deliberate: if "wrong password" and "no
such account" returned different messages, an attacker could use the login
endpoint to enumerate which emails have accounts (try a list of addresses,
see which ones say "wrong password" vs. "no account"). Login is
attacker-facing in a way signup isn't (credential-stuffing bots hit login
endpoints, not signup endpoints), so it gets the more paranoid treatment.

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
    return prisma.user.update({
      where: { id: existing.id },
      data: { googleId: profile.googleId, isEmailVerified: true },
    });
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
   Requiring Google's own verification closes that off.
3. **No match at all** (`existing` is `null`) — brand new user,
   `passwordHash: null` (they can never log in with a password — only
   Google — unless a "set a password" feature is added later).

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
  const code = crypto.randomBytes(24).toString('hex');
  store.set(code, { user, tokens, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return code;
}
```
`purgeExpired()` runs on every `createHandoff` call rather than on a timer —
simple, and sufficient: since a real OAuth login is the only thing that ever
calls this, the store can only ever accumulate entries roughly as fast as
people log in, and each login opportunistically sweeps out anything stale.
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
    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}
```
This route is only reachable after `requireAuth` middleware has already run
(see the route definitions in §15), so `req.user` is always set in practice
— the `if (!req.user)` check is a defensive fallback for the type checker
and against future misconfiguration, not a real code path today. Notice it
re-fetches the user from the database rather than just trusting the JWT
payload: the JWT only proves "this was the user at token-issue time" — if
the account is deleted, or a security feature blocks it after the token was
issued, a fresh DB read reflects that; the JWT payload itself could be
stale.

Now the OAuth handlers — this is the part worth reading most carefully:

```ts
const OAUTH_STATE_COOKIE = 'oauth_state';

export function googleRedirect(req: Request, res: Response) {
  const state = crypto.randomBytes(24).toString('hex');

  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: true,
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

```ts
export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, state } = req.query;
    const cookieState = req.signedCookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE);

    if (typeof code !== 'string') {
      throw new AppError(400, 'Missing authorization code');
    }
    if (!state || !cookieState || state !== cookieState) {
      throw new AppError(400, 'Invalid or missing OAuth state');
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
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { message: err.message } });
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

The branch is the crucial security property of this whole file: known,
"expected" errors (`AppError` — wrong password, duplicate email, expired
token, ...) are shown to the client with their specific message. Anything
*else* — a bug, a database connection failure, an unexpected exception deep
in some library — is logged in full server-side (`console.error`, where a
real deploy would send it to a log aggregator/error tracker) but the client
only ever sees a generic `"Internal server error"`. This is what prevents,
say, a raw Postgres constraint-violation message (which can reveal schema
details) or a stack trace from ever reaching a client response.

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
    req.body = result.data.body ?? req.body;
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
`req.body = result.data.body` — after validation, replaces `req.body` with
zod's *parsed* output rather than the raw input, so downstream code gets the
benefit of zod's transforms (e.g. `.trim()` on email, defined in
`auth.validators.ts` below) automatically.

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
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});
```
Applied to `signup`/`login`/`refresh`/`logout`/`google/exchange` (§17) —
allows 20 requests per IP per 15-minute window before responding `429 Too
Many Requests`. This is a coarse, first-line defense against brute-forcing
passwords, hammering the signup endpoint, or guessing at refresh/exchange
codes; it's per-IP and in-memory (see the caveats in `README.md` about what
that does and doesn't protect against at scale). `logout` carries the same
limiter as the others for a specific reason: it's the one mutation route
that used to be left unlimited (an earlier version only put it on
`signup`/`login`/`refresh`), which meant an attacker could send unbounded
`POST /logout` requests trying guessed `refreshToken` values against
`prisma.refreshToken.updateMany` with no per-IP throttling at all — every
other token-touching route was rate-limited, this one just got missed.

---

## 17. `src/routes/auth.routes.ts` — wiring it all together

```ts
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
```
Express middleware runs left to right. For `POST /signup`: rate-limit check
first (cheapest, rejects abuse before doing any real work) → validate the
body shape → only then does the actual controller function run. `/me` runs
`requireAuth` first — if that calls `next(err)` instead of `next()`, the
controller function never executes at all. Every mutating auth route now
carries `authRateLimiter` — `/logout` included, unlike an earlier version of
this file (see §16 for why that mattered) — while the two `GET` routes that
just redirect the browser through Google's own consent screen don't need it
the same way.

---

## 18. `src/app.ts` — assembling the Express app

```ts
function corsOrigin(): boolean | string[] {
  if (env.CORS_ALLOWED_ORIGINS) {
    return env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  }
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
```
Order matters throughout:
- `helmet()` — sets a batch of security-related HTTP response headers
  (`X-Content-Type-Options`, a conservative default CSP, etc.) — applied
  first so it covers every response, including error responses.
- `cors({ origin: corsOrigin() })` — enables Cross-Origin Resource Sharing so
  a frontend on a different domain/port can call this API from a browser.
  `corsOrigin()` decides *which* origins are allowed, and its three-way
  branch is worth reading closely, because an earlier version of this file
  just called `cors()` with no arguments at all — the library's own default,
  which is `Access-Control-Allow-Origin: *`, reflecting literally any
  origin, on literally every route in the API, with no way to narrow it
  short of editing code. That's a real widening of the attack surface: it
  means any website, anywhere, can have a visiting browser make
  authenticated-looking fetch calls to this API and read the JSON responses
  (the browser's Same-Origin Policy is exactly what CORS headers are
  overriding here — `*` opts out of that protection entirely, for every
  caller, unconditionally). `corsOrigin()` fixes that by making the open
  case something the deploy has to opt into, not the shipped default:
  - **An allowlist is configured** (`CORS_ALLOWED_ORIGINS` is set) — only
    those exact origins, split on commas. This is the real production setup.
  - **Nothing configured, but `NODE_ENV` is `production`** — returns
    `false`, meaning cross-origin requests are refused across the board.
    This is the important branch: it means forgetting to set
    `CORS_ALLOWED_ORIGINS` in a production deploy fails *closed* (nothing
    works cross-origin until it's configured) rather than *open* (silently
    falling back to allowing everyone) — a misconfiguration that's loud and
    breaks the frontend immediately is much easier to catch than one that
    quietly leaves an API globally readable.
  - **Nothing configured, and not production** — returns `true`, which `cors`
    treats as "reflect whatever `Origin` header the request sent." This is
    the convenience default for local development, where a frontend might be
    running on any of several arbitrary ports.
- `express.json()` — parses `application/json` request bodies into
  `req.body`; without this, `req.body` would be `undefined` and every
  `validate(...)` call would fail.
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
app.listen(env.PORT, () => {
  console.log(`auth-service listening on port ${env.PORT} (${env.NODE_ENV})`);
});
```
The only file that calls `.listen(...)` — kept separate from `app.ts`
specifically so tests (`supertest(app)`) can exercise the whole HTTP stack
in-process, without binding a real port at all.

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
Confirms: sign→verify round-trips to the exact original payload; a token
signed with a *different* secret is rejected (proves signature checking
actually works, not just structural parsing); an already-expired token is
rejected with the specific `TokenExpiredError`; a token missing the `email`
claim is rejected even though its signature is otherwise valid.

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

### `tests/unit/oauthHandoff.service.test.ts`
Direct tests for the handoff store (§11a), separate from the OAuth flow
that normally drives it: round-trips a stashed user/tokens pair through its
code; confirms it's genuinely single-use (a second `consumeHandoff` of the
same code returns `undefined`); rejects a code that was never issued; and —
using `jest.useFakeTimers()` to fast-forward past the 60-second TTL without
an actual 60-second test — confirms an expired code is rejected even on its
first-ever consume attempt.

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
mislabel other database failures.

### `tests/unit/google.service.test.ts`
Covers all three branches of `findOrCreateGoogleUser` from §11: already
linked → returned as-is, `findFirst` called exactly once (locking in the
single-round-trip fix — the earlier two-`findUnique`-calls version would
still have passed a test asserting the *result*, so this explicitly checks
the call count too); matching email + verified → linked via `update`;
matching email + **not** verified → rejected, `update` never called (the
account-takeover guard, explicitly tested); no match at all → `create`
called with `passwordHash: null`.

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
against a nonexistent account → `401`; `/me` with no auth header → `401`;
`GET /auth/google` → a real `302` redirect whose `Location` header points at
`accounts.google.com`, with the `oauth_state` cookie actually set on the
response; `POST /auth/google/exchange` → an unknown code rejected with
`400`, and a code obtained by calling `createHandoff` directly (standing in
for what `googleCallback` would have done) successfully exchanged once and
rejected the second time it's tried — proving the single-use property holds
through the actual route, not just the service function in isolation; any
unrecognized route → a clean `404` JSON error (proving `notFoundHandler` is
wired in correctly).

---

## Request lifecycle, start to finish (signup example)

To tie it all together, here's literally everything that happens for one
`POST /api/auth/signup` call, in order:

1. `server.ts`'s `app.listen(...)` has an Express app (`app.ts`) listening.
2. Request hits `helmet()` → `cors({ origin: corsOrigin() })` →
   `express.json()` (parses the JSON body into `req.body`) → `cookieParser()`.
3. Express matches `/api/auth/*` → into `auth.routes.ts`.
4. `authRateLimiter` — allowed to proceed (under the limit).
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

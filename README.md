# auth-service

A REST API auth service: email/password signup + login, Google OAuth login, and
JWT-based sessions, backed by Postgres via Prisma.

For a full line-by-line explanation of every file, see **[EXPLANATION.md](./EXPLANATION.md)**.

## Stack

- Node.js + TypeScript + Express
- PostgreSQL + [Prisma](https://www.prisma.io/) (schema + migrations + typed client)
- JWT access tokens (`jsonwebtoken`) + opaque, rotated, hashed refresh tokens
- `bcryptjs` for password hashing
- `google-auth-library` for the Google OAuth authorization-code flow
- `zod` for request validation
- Jest + Supertest + `jest-mock-extended` for tests

## Setup

```bash
npm install

# Start a local Postgres (or point DATABASE_URL at your own instance)
docker compose up -d

cp .env.example .env
# then fill in .env — at minimum DATABASE_URL, JWT_ACCESS_SECRET, COOKIE_SECRET,
# and the GOOGLE_* values from https://console.cloud.google.com/apis/credentials
# (Authorized redirect URI must exactly match GOOGLE_REDIRECT_URI).
# CORS_ALLOWED_ORIGINS (already set to http://localhost:3000, matching
# project/frontend-test) is REQUIRED in every environment, including local
# dev — there's no NODE_ENV-based default-open behavior; see .env.example.
# If running behind a reverse proxy/load balancer, also set TRUST_PROXY.

npx prisma migrate dev --name init   # creates the users / refresh_tokens tables
npm run dev                          # http://localhost:4000
```

## Tests

```bash
npm test
```

Unit tests never touch a real database — Prisma is replaced with a deep mock
(`tests/mocks/prisma.mock.ts`), so they run instantly and deterministically.
See EXPLANATION.md for how the mocking works and what each test covers.

This has actually been run, not just written: 70 tests passing, `tsc --noEmit`
clean, and the full HTTP flow (signup/login/refresh rotation/reuse-detection/
Google redirect/CORS behavior/trust-proxy/body-size-limit/graceful shutdown)
exercised against a real Postgres instance — see the session transcript
linked in the commits if you want the raw output.

## API

| Method | Path                        | Auth           | Body / Query                         |
|--------|-----------------------------|----------------|---------------------------------------|
| Method | Path                         | Rate limit | Auth           | Body / Query                         |
|--------|-------------------------------|------------|----------------|---------------------------------------|
| POST   | `/api/auth/signup`          | strict     | —              | `{ email, password, name? }`          |
| POST   | `/api/auth/login`           | strict     | —              | `{ email, password }`                 |
| POST   | `/api/auth/refresh`         | standard   | —              | `{ refreshToken }`                    |
| POST   | `/api/auth/logout`          | standard   | —              | `{ refreshToken }`                    |
| GET    | `/api/auth/me`              | —          | Bearer token   | —                                      |
| GET    | `/api/auth/google`          | —          | —              | redirects to Google                   |
| GET    | `/api/auth/google/callback` | —          | —              | `?code=&state=` (set by Google)       |
| POST   | `/api/auth/google/exchange` | standard   | —              | `{ code }` (the handoff code from the callback redirect, not Google's own `code`) |

"strict" and "standard" are two **separate** rate-limit budgets (`RATE_LIMIT_STRICT_MAX`/`RATE_LIMIT_STANDARD_MAX`, both per-IP) — signup/login don't share a counter with refresh/logout/exchange, so a burst on one can't lock a client out of the other.

Signup/login/refresh responses look like:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "isEmailVerified": false, "createdAt": "..." },
  "tokens": { "accessToken": "...", "refreshToken": "..." }
}
```

`POST /api/auth/google/exchange` returns the same shape. The Google flow is
three hops, not two: `GET /auth/google` → Google's consent screen → `GET
/auth/google/callback` (server-side; verifies the OAuth `state`, creates/links
the user, then redirects the browser to `OAUTH_SUCCESS_REDIRECT_URL?code=<handoffCode>`)
→ the frontend immediately calls `POST /auth/google/exchange` with that `code`
to get the real `user`/`tokens`. The handoff code is single-use and expires
after 60 seconds — it exists purely so the real tokens never appear in a URL
(see EXPLANATION.md for why that matters).

## Security notes / production hardening ideas

These were deliberate scope cuts for a self-contained example — worth knowing
about before shipping this as-is:

- **OAuth handoff store is in-process memory** (`src/services/oauthHandoff.service.ts`,
  bounded at 1000 entries as a backstop), fine for a single backend instance
  but invisible to any other instance — a multi-instance deployment behind a
  load balancer needs a shared store (Redis, or a short-lived DB row)
  instead, or sticky sessions as a stopgap. Same caveat for rate limiting
  (`express-rate-limit`'s default in-memory store) — per-instance counters,
  not shared across instances, unless you configure a shared store.
- **No email verification flow** for password signups (`isEmailVerified`
  stays `false` until/unless a Google account gets linked). Add a
  verification-email step before trusting `isEmailVerified`.
- **Refresh token reuse detection** revokes all of a user's other sessions
  when a used-and-revoked token is replayed, but doesn't yet alert/log that
  as a security event anywhere — worth wiring into monitoring.
- **Rate limiting is per-IP**, not per-account — a solid baseline, not a
  substitute for per-account lockout/backoff in a production system.
- **JWT algorithm** is HS256 (shared secret). Fine here; RS256 with a
  private/public keypair is preferable if other services need to verify
  tokens without holding the signing secret.
- **Password max length (72 chars)** is a conservative proxy for bcrypt's
  real 72-*byte* limit — a password using many multi-byte UTF-8 characters
  could still exceed 72 bytes while under 72 characters. Good enough to
  close the common case; a byte-length check would be exact.
- **`TRUST_PROXY` is unset by default** (correct for direct-connection local
  dev) — if you deploy this behind nginx/an ALB/Cloudflare/etc., you
  **must** set it (see `.env.example`), or every request's `req.ip` (and
  therefore every rate limit) sees the proxy's IP, not the real client's.

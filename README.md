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
# (Authorized redirect URI must exactly match GOOGLE_REDIRECT_URI)

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

> **Note on this environment:** this code was written and reviewed here, but
> Node.js/npm isn't installed in the sandbox this was built in, so `npm install`
> and `npm test` could not actually be executed here. Run them yourself after
> `npm install` — the test suite is the real verification step.

## API

| Method | Path                       | Auth           | Body / Query                         |
|--------|----------------------------|----------------|---------------------------------------|
| POST   | `/api/auth/signup`         | —              | `{ email, password, name? }`          |
| POST   | `/api/auth/login`          | —              | `{ email, password }`                 |
| POST   | `/api/auth/refresh`        | —              | `{ refreshToken }`                    |
| POST   | `/api/auth/logout`         | —              | `{ refreshToken }`                    |
| GET    | `/api/auth/me`             | Bearer token   | —                                      |
| GET    | `/api/auth/google`         | —              | redirects to Google                   |
| GET    | `/api/auth/google/callback`| —              | `?code=&state=` (set by Google)       |

Signup/login/refresh responses look like:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "isEmailVerified": false, "createdAt": "..." },
  "tokens": { "accessToken": "...", "refreshToken": "..." }
}
```

## Security notes / production hardening ideas

These were deliberate scope cuts for a self-contained example — worth knowing
about before shipping this as-is:

- **Google callback token delivery**: the callback currently redirects with
  tokens as query params (`?accessToken=&refreshToken=`) since there's no
  frontend yet to hand them to directly. Query params can leak via browser
  history/referrer headers/server logs. In production, prefer redirecting
  with a short-lived one-time code that the frontend immediately exchanges
  via POST for the real tokens, or set the tokens as `httpOnly` cookies
  instead.
- **No email verification flow** for password signups (`isEmailVerified`
  stays `false` until/unless a Google account gets linked). Add a
  verification-email step before trusting `isEmailVerified`.
- **Refresh token reuse detection** revokes all of a user's other sessions
  when a used-and-revoked token is replayed, but doesn't yet alert/log that
  as a security event anywhere — worth wiring into monitoring.
- **Rate limiting** is per-IP and in-memory (`express-rate-limit` defaults) —
  fine for a single instance, not for multiple instances behind a load
  balancer (use a shared store like Redis) or for per-account lockout.
- **JWT algorithm** is HS256 (shared secret). Fine here; RS256 with a
  private/public keypair is preferable if other services need to verify
  tokens without holding the signing secret.

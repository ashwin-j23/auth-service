# auth-service

A REST API auth service: email/password signup + login, Google OAuth login, and
JWT-based sessions, backed by Postgres via Prisma.

For a full line-by-line explanation of every file, see **[EXPLANATION.md](./EXPLANATION.md)**.

## Stack

- Node.js (>= 20 — see `package.json`'s `engines`; `nodemailer` 10 requires it) + TypeScript + Express
- `tsx` for the local dev server (`npm run dev`), auto-restarting on file changes
- PostgreSQL + [Prisma](https://www.prisma.io/) (schema + migrations + typed client)
- JWT access tokens (`jsonwebtoken`) + opaque, rotated, hashed refresh tokens
- `bcryptjs` for password hashing
- `google-auth-library` for the Google OAuth authorization-code flow
- `nodemailer`, against an [Ethereal](https://ethereal.email) test transport,
  for email verification / password-reset links
- `zod` for request validation
- Jest + Supertest + `jest-mock-extended` for tests

## Setup

```bash
npm install

# Start a local Postgres (or point DATABASE_URL at your own instance).
# docker-compose.yml also defines `app`/`nginx`/`certbot` for a full server
# deploy (see "Deploying" below) — not needed for local dev, so scope this
# to just the database:
docker compose up -d postgres

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

If you set up the database before this `isActive`/lockout addition, run
`npx prisma migrate dev` again to pick up the new columns.

If you set up the database before the email-verification/password-reset
addition, run `npx prisma migrate dev` again to create the
`verification_tokens` table.

Outbound email (verification/reset links) goes through a real SMTP
connection to [Ethereal](https://ethereal.email) — no local mail server
needed, but it does need network access. On first send, if
`ETHEREAL_SMTP_USER`/`ETHEREAL_SMTP_PASS` aren't set, the app mints a
throwaway Ethereal account and logs it; every send after that also logs a
preview URL — that link is how you actually read a "sent" email in dev,
since Ethereal never delivers anywhere real. See `.env.example`.

## Deploying (nginx + Let's Encrypt, via docker-compose)

`docker-compose.yml` includes an `nginx` service that terminates TLS for
**https://ashwin.opsmonsters.com** and reverse-proxies to the `app`
service, plus a `certbot` service that keeps the certificate renewed.
Config is in `nginx/conf.d/ashwin.opsmonsters.com.conf`.

Prerequisites:

- A server with Docker + the Compose plugin, ports 80 and 443 open.
- `ashwin.opsmonsters.com`'s DNS record in Cloudflare already points at
  this server's IP and is set to **DNS-only (grey cloud)** — Let's
  Encrypt's HTTP challenge and TLS termination both happen on this box
  directly, not through Cloudflare's proxy. (If you switch that record to
  proxied/orange-cloud later, set Cloudflare's SSL/TLS mode to "Full
  (strict)" so it doesn't break against this setup.)

```bash
git clone <this repo> && cd auth-service   # on the server

cp .env.example .env
# Fill in real secrets: JWT_ACCESS_SECRET, COOKIE_SECRET, GOOGLE_*,
# CORS_ALLOWED_ORIGINS (your real frontend origin, not localhost),
# OAUTH_SUCCESS_REDIRECT_URL / EMAIL_VERIFICATION_URL / PASSWORD_RESET_URL
# (your real frontend routes). TRUST_PROXY is already set for you by
# docker-compose.yml — no need to set it in .env for this path.

# One-time TLS bootstrap (see scripts/init-letsencrypt.sh for what this
# does) — needs port 80 reachable from the internet already:
./scripts/init-letsencrypt.sh you@example.com

# Bring up the full stack: postgres, the migrate job, the app, nginx, certbot
docker compose up -d --build
```

The site is then live at `https://ashwin.opsmonsters.com` (nginx proxies
`/` and `/health` to the app on its internal docker network; the app's own
port is bound to `127.0.0.1` only — see the `app` service's `ports:` — so
it's not reachable from outside except through nginx).

To pick up code changes later: `git pull && docker compose up -d --build`.

Renewal: the `certbot` service checks twice a day and renews automatically
when the cert is within 30 days of expiry, but nginx doesn't reload on its
own to pick up a renewed cert — add a host cron entry like:

```cron
0 3 * * * cd /path/to/auth-service && docker compose exec nginx nginx -s reload
```

(harmless to run daily even when nothing renewed).

## Tests

```bash
npm test
```

Unit tests never touch a real database — Prisma is replaced with a deep mock
(`tests/mocks/prisma.mock.ts`), so they run instantly and deterministically.
See EXPLANATION.md for how the mocking works and what each test covers.

This has actually been run, not just written: 144 tests passing (all 17
suites), `tsc --noEmit` clean, and the full HTTP flow (including the
email-verification / password-reset / Google-linking fixes, and the
follow-up fixes from an automated review of that same PR) exercised
against a real Postgres instance — signup sending a real email through
Ethereal, the Google-linking account-takeover block reproduced and then
lifted via a real password reset, old passwords invalidated and sessions
revoked on reset, a verification token consumed exactly once through its
new transactional path, and — the one that actually caught a real bug —
15-30 truly concurrent wrong-password requests against a fresh account,
repeated across several fix iterations, until the account reliably ends
up locked with a plausible attempt count every time instead of
intermittently unlocked with an under-count. See the session transcript
linked in the commit if you want the raw output.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: `npm ci`, `npx
prisma generate`, `npx tsc --noEmit`, then `npm test` — on Node 20.x and
22.x (18.x is dropped; it went EOL in April 2025). No database service
container or secrets are needed: `prisma generate` only reads
`prisma/schema.prisma` (no live connection), and every env var the app
needs is already seeded by `tests/setup.ts` before the suite runs.

This replaces two earlier workflow files (a "Deno" workflow and a "NodeJS
with Webpack" one) that were GitHub's generic starter templates, added
as-is without adapting them to this project — this is a Node/Express/Jest
app with no Deno code and no webpack config or dependency, so both failed
on every run for reasons that had nothing to do with the actual code:
`deno test` can't resolve this project's npm-style imports (`@prisma/client`,
Jest globals, ...) and exits within a few seconds of trying, and `npx
webpack` with neither webpack nor a config installed drops into npm's
"install this for me? (yes/no)" prompt, which has no terminal to answer it
in CI and fails immediately.

## API

| Method | Path                         | Rate limit | Auth           | Body / Query                          |
|--------|------------------------------|------------|----------------|-----------------------------------------|
| POST   | `/api/auth/signup`          | strict     | —              | `{ email, password, name? }`          |
| POST   | `/api/auth/login`           | strict     | —              | `{ email, password }`                 |
| POST   | `/api/auth/refresh`         | standard   | —              | `{ refreshToken }`                    |
| POST   | `/api/auth/logout`          | standard   | —              | `{ refreshToken }`                    |
| GET    | `/api/auth/me`              | —          | Bearer token   | — (403 if the account is disabled)     |
| GET    | `/api/auth/google`          | standard   | —              | redirects to Google                   |
| GET    | `/api/auth/google/callback` | standard   | —              | `?code=&state=` (set by Google)       |
| POST   | `/api/auth/google/exchange` | standard   | —              | `{ code }` (the handoff code from the callback redirect, not Google's own `code`) |
| POST   | `/api/auth/email/verify`    | email      | —              | `{ email }` — sends/resends a verification link |
| POST   | `/api/auth/email/verify/confirm` | standard | —          | `{ token }` |
| POST   | `/api/auth/password/reset`  | email      | —              | `{ email }` — sends a reset link |
| POST   | `/api/auth/password/reset/confirm` | standard | —       | `{ token, password }` — also revokes every existing session on the account |

The four email-verification/password-reset endpoints all return a generic
`{ message }`, not a token pair — see EXPLANATION.md for why `request`-side
responses are deliberately identical whether or not an account/email
actually exists (the same enumeration-resistance reasoning as `login`'s
generic `401`), and why `confirm`-side password reset doesn't hand back
fresh tokens (every existing session is revoked as part of it; log in again
with the new password).

"strict", "standard", and "email" are three **separate** rate-limit budgets (each its own instance, all per-IP; "email" reuses `RATE_LIMIT_STRICT_MAX` as its cap but with its own independent counter — see `rateLimit.middleware.ts`) — signup/login don't share a counter with refresh/logout/exchange/the Google routes, and neither shares one with the email-verification/password-reset "request" endpoints, so a burst on one can't lock a client out of another.

`login` also enforces an **account-level lockout**, independent of the per-IP
limiter above: `LOCKOUT_MAX_ATTEMPTS` (default 5) wrong passwords in a row
locks that specific account for `LOCKOUT_DURATION_MS` (default 15 minutes) —
even to the correct password — regardless of which IP the attempts came
from. Every response stays the same generic `401`/message whether the
account doesn't exist, is disabled, is currently locked, or the password was
simply wrong, so none of that is distinguishable from the outside.

Signup/login/refresh responses look like:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "isEmailVerified": false, "createdAt": "..." },
  "tokens": { "accessToken": "...", "refreshToken": "..." }
}
```

`POST /api/auth/google/exchange` returns the same shape. The Google flow is
three hops, not two: `GET /auth/google` → Google's consent screen → `GET
/auth/google/callback` (server-side; verifies the OAuth `state`, the PKCE
`code_verifier`, and the OIDC `nonce`, creates/links the user, then redirects
the browser to `OAUTH_SUCCESS_REDIRECT_URL?code=<handoffCode>`)
→ the frontend immediately calls `POST /auth/google/exchange` with that `code`
to get the real `user`/`tokens`. The handoff code is single-use and expires
after 60 seconds — it exists purely so the real tokens never appear in a URL
(see EXPLANATION.md for why that matters).

`GET /auth/google` generates `state` (CSRF), a PKCE `code_verifier`/
`code_challenge` pair (RFC 7636), and an OIDC `nonce`, all bundled into one
short-lived signed cookie. `code_challenge`/`code_challenge_method=S256` go to
Google up front; `code_verifier` is sent back at token-exchange time so Google
can confirm the two match (closing authorization-code interception), and the
`nonce` is checked against the claim Google's ID token echoes back (closing ID
token replay from a different flow).

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
- **Email verification now exists** (`POST /api/auth/email/verify` +
  `/confirm`, auto-sent on signup too) — but it uses Ethereal
  (`src/services/mail.service.ts`), which never delivers anywhere real.
  Swap in a real transactional-email provider before this is anywhere near
  production traffic.
- **Password reset now exists** (`POST /api/auth/password/reset` +
  `/confirm`) — consuming a reset token also marks the account's email
  verified (proof of ownership) and revokes every outstanding session. This
  is also the fix for the Google-linking account-takeover finding below: an
  account an attacker signed up first, unverified, gets reclaimed by its
  real owner through this flow.
- **Google OAuth linking requires the EXISTING account to already be
  email-verified**, not just Google's own claim about the email
  (`src/services/google.service.ts`'s `findOrCreateGoogleUser`) — closes a
  "classic-federated merge" pre-account-hijacking gap: previously, an
  attacker could sign up first with a victim's email (no verification was
  ever required for a password account) and the victim's later, genuinely
  Google-verified sign-in would silently link onto — and leave standing
  password access on — the attacker's account. An unverified collision now
  gets a `409` telling the user to verify their email or reset their
  password first (see the two points above) instead of linking silently.
- **Refresh token reuse detection now logs a structured `console.error`**
  (`src/services/token.service.ts`) when a used-and-revoked token is
  replayed — this project has no logging/alerting pipeline configured, so
  wiring that log line into real monitoring (it's the single most
  security-relevant event this service can produce) is the next step.
- **Account-level lockout counter is now a single atomic `UPDATE`**
  (`src/services/auth.service.ts`'s `login()`), not a JS-computed value
  written back — closes a race where several concurrent wrong-password
  requests could collapse into the counter advancing by only 1 instead of
  N. Verified against a real, truly-concurrent Postgres run (see that
  function's comment for the two bugs this closed and how each was
  reproduced live, including a session-timezone gotcha in a mixed
  raw-SQL/Prisma comparison that never actually shipped but is worth
  knowing about).
- **Google consent denial (`Cancel` on the consent screen) now redirects
  back to `OAUTH_SUCCESS_REDIRECT_URL?error=google_consent_denied`**
  instead of dead-ending on a raw `400` — but only for that specific error
  code; other OAuth provider errors (`server_error`,
  `temporarily_unavailable`, ...) still get the generic handling, not a
  misleading "consent denied" label — `src/controllers/auth.controller.ts`.
- **Consuming a verification/reset token and applying its effect (marking
  an email verified; setting a new password + revoking sessions) now
  commit in one transaction** (`src/services/auth.service.ts`,
  `src/services/verification.service.ts`) — a single-use token failing
  partway through used to mean it was burned with no effect, or a new
  password taking hold while old sessions stayed valid.
- **`nodemailer` is pinned to `^10.0.1`** (up from `^6.9.15`) — the
  original pin had three known CVEs (a stack-overflow DoS, a
  disableFileAccess/disableUrlAccess bypass, and a quadratic-time address
  parser), all fixed by `9.1.0`.
- **`npm audit` is clean (0 vulnerabilities)** via `package.json`'s
  `overrides` — `qs` (pulled in below the patched version by `express`
  itself; there's no 4.x `express` release that resolves a fixed `qs`, only
  5.x, a breaking major this project isn't taking on for this alone) and
  `uuid` (pulled in below the patched version by `google-auth-library` →
  `gaxios`) are both forced to a safe minimum this way instead. `jest` was
  also bumped to 30.x (with a matching `jest-mock-extended` 4.x and
  `@types/jest` 30.x) specifically to drop the `rimraf`/`glob`/`inflight`
  chain the old `ts-node-dev` dev dependency and jest 29's own internals
  were pulling in; `ts-node-dev` itself was replaced with `tsx` (see
  `npm run dev`) for the same reason. One deprecation warning remains —
  `lodash.isequal`, a direct dependency of `jest-mock-extended` itself —
  and needs an upstream release to clear; there's nothing to override it
  to.
- **Access/refresh tokens are returned in the JSON response body, not as
  `httpOnly` cookies** — a deliberate architectural choice, not an
  oversight, but one worth stating explicitly rather than leaving implicit:
  it means whatever frontend consumes this API is responsible for deciding
  where to hold a long-lived bearer token in a way that isn't readable by
  arbitrary JS on the page (most reach for `localStorage`, which reopens
  the door to token theft via XSS — a risk this service is otherwise
  careful about, see the refresh-rotation/reuse-detection design). If a
  browser-based frontend consumes this API directly, consider moving at
  least the refresh token into an `httpOnly` cookie instead of leaving that
  decision to whichever client integrates first.
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
- **`isActive` (account suspension) is checked on `/me`, `login`, and
  `refresh`** — the three places a disabled account could otherwise keep
  working. There's no admin endpoint to actually *set* `isActive: false`
  yet (do it directly in the database, or add one) — the enforcement is
  built, the admin tooling to drive it isn't, in keeping with this
  project's scope.
- **Access tokens carry a `jti` (unique per-token ID) but nothing checks it
  yet** — there's no revocation list. A compromised or otherwise-bad access
  token stays valid until it naturally expires (15 minutes by default); it
  can't be individually invalidated early. The `jti` is there as groundwork
  for that (a revocation list needs a per-token identifier to blocklist) —
  implementing the list itself needs a shared store (e.g. Redis) checked on
  every authenticated request, a real latency/infrastructure tradeoff
  against the current fully-stateless design, deferred until immediate
  token revocation is an actual requirement.
- **`OAUTH_HANDOFF_MAX_ENTRIES` (default 5000) is a memory bound, not a
  free one** — hitting it rejects the *new* handoff (`503`, retryable)
  rather than evicting an existing, still-pending one, so a spike never
  silently breaks a *different* user's already-succeeding login. Sized high
  enough that only a genuinely abnormal volume of concurrent, unexchanged
  Google logins would ever reach it; logged as an error when it does, so
  it's observable rather than a silent, confusing one-off failure.
- **`CORS_ALLOWED_ORIGINS` is validated at boot**, not just split on commas
  — each origin must look like `https://example.com` (scheme + host[:port],
  no path, no trailing slash — a real browser `Origin` header never has
  either), and an empty/comma-only value is rejected outright rather than
  silently producing a broken allowlist that would never match anything.

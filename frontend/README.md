# Auth Console — Frontend

A React 18 + TypeScript + Vite SPA that implements every user-facing flow exposed by the auth
service in `../src`: signup, login, Google OAuth (PKCE + state + nonce), email verification,
password reset, silent token refresh, and a protected dashboard/settings area.

## Stack

- **React 18 + TypeScript + Vite** — routing via `react-router-dom` v6
- **Zustand** — client auth/session state (`src/store/authStore.ts`, `themeStore.ts`)
- **TanStack Query** — server-state caching for `/me` (`src/hooks/useMe.ts`)
- **React Hook Form + Zod** — forms, mirroring the backend's own validators
  (`src/schemas/auth.schemas.ts` ↔ `../src/validators/auth.validators.ts`)
- **Tailwind CSS** — design tokens for the indigo/slate palette, dark mode via `class` strategy
- **Framer Motion** — page/element transitions, modal + dropdown motion, animated password meter
- **Sonner** — toasts

## Getting started

```bash
cd frontend
npm install
cp .env.example .env   # point VITE_API_BASE_URL at your running backend
npm run dev             # http://localhost:3000
```

The backend must have this origin in `CORS_ALLOWED_ORIGINS` (its `.env.example` already ships
`http://localhost:3000` for local dev) and `OAUTH_SUCCESS_REDIRECT_URL=http://localhost:3000/oauth/callback`.

## Token handling — a deliberate deviation from the "ideal" architecture

The backend (`src/controllers/auth.controller.ts`) returns the refresh token in the JSON body on
`/signup`, `/login`, `/refresh`, and `/google/exchange` — it does **not** set it as an HttpOnly
cookie, and `/refresh`/`/logout` both require `refreshToken` in the request body
(`refreshSchema` in `auth.validators.ts`). Given that actual contract:

- **Access token** lives in memory only (inside the API client, mirrored in the Zustand store for
  scheduling) — never persisted, never sent anywhere but the `Authorization` header.
- **Refresh token** is persisted to `sessionStorage` (not `localStorage`, so it doesn't outlive the
  tab) purely so a page reload doesn't force a full re-login. This is a pragmatic compromise, not
  the recommended end state — an XSS bug can read `sessionStorage`. If the backend adds an HttpOnly
  `Set-Cookie` on those four routes, delete the `sessionStorage` calls in `authStore.ts` and switch
  `client.ts`'s `fetch` calls to `credentials: 'include'`; everything else (guards, silent refresh,
  UI) is unaffected.

## Routes

| Route | Guard | Notes |
|---|---|---|
| `/login`, `/signup` | public-only (redirects away if authenticated) | |
| `/verify-email` | public | reads `?token=` to confirm, or `?pending=true` after signup |
| `/reset-password/request` | public-only | sends the reset email |
| `/reset-password` | public-only | reads `?token=`, sets a new password |
| `/oauth/callback` | public | exchanges the handoff `?code=` immediately on mount |
| `/dashboard`, `/settings/security`, `/settings/profile` | protected | bounces to `/login?redirect=…`, or `/verify-email` if unverified |
| `/403`, `/500` | any | static messaging pages |

## Honest gaps vs. the wishlist spec

Two pieces commonly found in an "auth settings" UI aren't wired to real functionality, because the
backend doesn't expose the endpoints yet:

- **Profile editing** (`/settings/profile`) is read-only — there's no `PATCH /me`. The page says so.
- **Change password while logged in** and **multi-device session listing/revocation**
  (`/settings/security`) aren't real endpoints either. Password changes reuse the existing
  `/password/reset` email flow instead of pretending an in-session change-password endpoint exists.

Both pages link out to what *is* real (the email-based reset flow, signing out the current device)
rather than shipping dead buttons.

## Scripts

- `npm run dev` — Vite dev server on port 3000
- `npm run build` — `tsc --noEmit` then `vite build`
- `npm run preview` — preview the production build
- `npm run lint:types` — type-check only

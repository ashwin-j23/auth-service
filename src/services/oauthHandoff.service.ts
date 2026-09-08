import crypto from 'crypto';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import type { PublicUser } from '../utils/publicUser';
import type { TokenPair } from './token.service';

/**
 * Short-lived, single-use handoff for delivering tokens after the Google
 * OAuth redirect, so the access/refresh tokens themselves never appear in a
 * URL — a URL can end up in browser history, the frontend's own server
 * access logs, or a Referer header sent to any third-party resource the
 * landing page loads. Instead, the browser is redirected with an opaque
 * `code`; the frontend immediately exchanges it for the real tokens via a
 * POST request (see POST /api/auth/google/exchange), the same way an OAuth
 * authorization code itself is never usable directly, only exchangeable.
 *
 * In-memory and per-process by design — fine for a single backend instance,
 * which is this project's stated scope. A multi-instance deployment behind
 * a load balancer would need a shared store instead (Redis, or a row in
 * Postgres with the same TTL/single-use semantics), since a handoff created
 * on one instance wouldn't be visible to whichever instance serves the
 * exchange request.
 */

interface HandoffEntry {
  user: PublicUser;
  tokens: TokenPair;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 60 * 1000; // must be exchanged within 1 minute
const store = new Map<string, HandoffEntry>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (entry.expiresAt < now) store.delete(code);
  }
}

/**
 * Stashes a login result behind a fresh opaque code and returns that code.
 * Throws AppError(503) if the store is at capacity even after purging
 * expired entries — see the comment below for why this rejects the new
 * entry rather than evicting an old one.
 */
export function createHandoff(user: PublicUser, tokens: TokenPair): string {
  purgeExpired();
  if (store.size >= env.OAUTH_HANDOFF_MAX_ENTRIES) {
    // Deliberately fails THIS request rather than evicting an existing
    // entry to make room. An earlier version evicted the oldest entry
    // (Map's insertion order made that the one closest to its own natural
    // expiry) — a reasonable-sounding "least harm" choice, but still a real
    // one: that entry belongs to a *different* person who already
    // completed a real Google login and simply hasn't finished the final
    // exchange step yet. Evicting it fails their login for a reason that
    // has nothing to do with anything they did — a confusing, silent,
    // unattributable failure for an innocent bystander.
    //
    // Rejecting the new request instead means the failure lands on the one
    // login attempt that's actually causing the overload, right now, with
    // an error the caller can act on (retry — a completely normal recovery
    // path for a transient "please try again"), instead of reaching
    // backward to break someone else's already-succeeding flow. This is
    // the standard trade-off for any bounded resource under pressure: fail
    // fast on the request that has a reasonable fallback (retry), rather
    // than silently discarding state that a *different* caller has no way
    // to know was ever at risk.
    //
    // OAUTH_HANDOFF_MAX_ENTRIES defaults to 5000 specifically to make
    // hitting this vanishingly unlikely under realistic traffic — it means
    // 5000 real, successful Google logins landed within the same ~60s TTL
    // window without being exchanged, which requires actual valid Google
    // accounts completing actual consent screens, not something trivially
    // scriptable at volume. Logged as an error (not silently thrown) since
    // reaching it at all is exactly the kind of thing that should page
    // someone.
    // eslint-disable-next-line no-console
    console.error(
      `oauthHandoff: store is full (${env.OAUTH_HANDOFF_MAX_ENTRIES} entries) — rejecting a new handoff rather than evicting someone else's pending login.`,
    );
    throw new AppError(503, 'Too many sign-ins in progress right now — please try again');
  }
  const code = crypto.randomBytes(24).toString('hex');
  store.set(code, { user, tokens, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return code;
}

/**
 * Consumes a handoff code — it's deleted whether or not it was valid, so it
 * can never be exchanged twice. Returns undefined for an unknown, expired,
 * or already-used code.
 */
export function consumeHandoff(code: string): { user: PublicUser; tokens: TokenPair } | undefined {
  const entry = store.get(code);
  store.delete(code);
  if (!entry || entry.expiresAt < Date.now()) {
    return undefined;
  }
  return { user: entry.user, tokens: entry.tokens };
}

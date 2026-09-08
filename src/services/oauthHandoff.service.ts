import crypto from 'crypto';
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
// A defensive cap, not an expected operating point: purgeExpired() below
// keeps normal usage far under this even during a heavy burst of logins
// (each entry only lives ~60s), but bounding store.size means a sustained
// flood of Google logins within a single TTL window — whatever the cause —
// can't grow this map without bound in a long-running process.
const MAX_HANDOFF_ENTRIES = 1000;
const store = new Map<string, HandoffEntry>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (entry.expiresAt < now) store.delete(code);
  }
}

/** Stashes a login result behind a fresh opaque code and returns that code. */
export function createHandoff(user: PublicUser, tokens: TokenPair): string {
  purgeExpired();
  if (store.size >= MAX_HANDOFF_ENTRIES) {
    // Still over the cap after purging expired entries — evict the oldest
    // one. Map iteration order is insertion order, so the first key from
    // the iterator is the oldest surviving entry.
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
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

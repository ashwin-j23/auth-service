/** Reads the `exp` claim out of a JWT without verifying it — only ever used
 * client-side to schedule a proactive refresh, never to trust the token's
 * contents. The server is the only thing that verifies signatures. */
export function getJwtExpiryMs(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = JSON.parse(atob(padded)) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

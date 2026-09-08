// Shared by every code path that ever looks up or stores a user's email
// (auth.service.ts and google.service.ts) so the two never drift into
// treating the "same" address as two different canonical strings — which
// would let, say, a Google account fail to link to its matching
// password-based account (see google.service.ts's findOrCreateGoogleUser).
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

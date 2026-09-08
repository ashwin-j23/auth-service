// Shared by every code path that ever looks up or stores a user's email
// (auth.service.ts and google.service.ts) so the two never drift into
// treating the "same" address as two different canonical strings — which
// would let, say, a Google account fail to link to its matching
// password-based account (see google.service.ts's findOrCreateGoogleUser).
export function normalizeEmail(email: string): string {
  // .normalize('NFC') collapses Unicode strings that render identically but
  // are encoded differently into one canonical form — e.g. "é" as a single
  // precomposed codepoint (U+00E9) vs. "e" + a combining acute accent
  // (U+0065 U+0301) look the same and mean the same thing, but are
  // different strings byte-for-byte, and would compare as different emails
  // (and fail the `email @unique` constraint's job of actually preventing
  // duplicates) without this. Applied before .toLowerCase() — normalize the
  // representation first, then case-fold it, not the other way around.
  return email.trim().normalize('NFC').toLowerCase();
}

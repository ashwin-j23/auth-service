import { normalizeEmail } from '../../src/utils/email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane@Example.com  ')).toBe('jane@example.com');
  });

  it('normalizes visually-identical but differently-encoded Unicode to the same string', () => {
    // "é" as one precomposed codepoint (NFC, U+00E9) vs. "e" + a combining
    // acute accent (NFD, U+0065 U+0301) — built with String.fromCodePoint,
    // not typed literally into this file, specifically so this test can't
    // silently end up with the same bytes on both sides just because some
    // layer in how this file itself gets authored/saved normalizes special
    // characters on the way in (a real risk for exactly this kind of test).
    // They render identically and mean the same thing, but are different
    // strings byte-for-byte without normalization.
    const eAcuteNFC = String.fromCodePoint(0x00e9); // "é", one codepoint
    const eAcuteNFD = String.fromCodePoint(0x0065, 0x0301); // "e" + combining acute accent

    const nfc = `jos${eAcuteNFC}@example.com`;
    const nfd = `jos${eAcuteNFD}@example.com`;

    expect(nfc).not.toBe(nfd); // different strings going in...
    expect(nfc.length).not.toBe(nfd.length); // ...provably different lengths, not just !==
    expect(normalizeEmail(nfc)).toBe(normalizeEmail(nfd)); // ...same one coming out
  });

  it('is idempotent — normalizing an already-normalized email is a no-op', () => {
    const eAcuteNFC = String.fromCodePoint(0x00e9);
    const normalized = normalizeEmail(`jos${eAcuteNFC}@example.com`);
    expect(normalizeEmail(normalized)).toBe(normalized);
  });
});

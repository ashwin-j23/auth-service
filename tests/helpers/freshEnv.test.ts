import { withFreshEnv } from './freshEnv';

// This helper is shared test infrastructure — a bug here doesn't just fail
// its own test, it silently corrupts every OTHER test that happens to run
// afterward in the same file (see the `finally` in freshEnv.ts for the full
// story of how this actually happened once already). Worth its own direct
// regression test, not just trust that the tests using it look right.
describe('withFreshEnv', () => {
  it('restores process.env after a normal (non-throwing) call', () => {
    const before = process.env.SOME_TEST_MARKER;
    withFreshEnv({ SOME_TEST_MARKER: 'set-during-the-call' }, () => {
      expect(process.env.SOME_TEST_MARKER).toBe('set-during-the-call');
    });
    expect(process.env.SOME_TEST_MARKER).toBe(before);
  });

  it('restores process.env even when the callback throws', () => {
    const before = process.env.SOME_TEST_MARKER;
    expect(() =>
      withFreshEnv({ SOME_TEST_MARKER: 'set-during-a-throwing-call' }, () => {
        expect(process.env.SOME_TEST_MARKER).toBe('set-during-a-throwing-call');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // The regression this guards: without a `finally`, this line would see
    // "set-during-a-throwing-call" left behind instead of the real prior
    // value, and every subsequent withFreshEnv call in the same file would
    // silently inherit it.
    expect(process.env.SOME_TEST_MARKER).toBe(before);
  });

  it('removes a variable that was explicitly overridden to undefined', () => {
    process.env.SOME_TEST_MARKER = 'pre-existing-value';
    withFreshEnv({ SOME_TEST_MARKER: undefined }, () => {
      expect(process.env.SOME_TEST_MARKER).toBeUndefined();
    });
    expect(process.env.SOME_TEST_MARKER).toBe('pre-existing-value');
    delete process.env.SOME_TEST_MARKER;
  });
});

import { generateState, safeEqual } from '../../src/auth/state.js';

describe('generateState', () => {
  test('returns 32 hex chars', () => {
    const s = generateState();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  test('successive calls differ', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe('safeEqual', () => {
  test('returns true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  test('returns false for one-char difference', () => {
    expect(safeEqual('abcd', 'abce')).toBe(false);
  });

  test('returns false for different lengths without throwing', () => {
    expect(() => safeEqual('a', 'abc')).not.toThrow();
    expect(safeEqual('a', 'abc')).toBe(false);
  });

  test('returns false for non-string inputs', () => {
    // @ts-expect-error testing runtime guard
    expect(safeEqual(undefined, 'x')).toBe(false);
  });
});

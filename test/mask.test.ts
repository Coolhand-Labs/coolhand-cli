import { maskToken } from '../src/mask.js';

describe('maskToken', () => {
  test('short tokens are fully masked', () => {
    expect(maskToken('short')).toBe('***');
    expect(maskToken('')).toBe('***');
    expect(maskToken('exactly_16_chars')).toBe('***');
  });

  test('long tokens are partially shown', () => {
    const token = 'ch_pub_AbCdEf0123456789xyz';
    const masked = maskToken(token);
    expect(masked).toContain('ch_pub_A');
    expect(masked).toContain('9xyz');
    expect(masked).not.toContain('CdEf01234567');
  });

  test('masked output omits the middle', () => {
    const token = 'ch_pub_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    expect(maskToken(token)).toMatch(/^ch_pub_A.+WXYZ$/);
  });
});

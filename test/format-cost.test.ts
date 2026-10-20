import { formatCost } from '../src/format-cost.js';

describe('formatCost', () => {
  test('formats with 4 decimals', () => {
    expect(formatCost(0.5)).toBe('$0.5000');
    expect(formatCost(5.02134)).toBe('$5.0213');
  });

  test('prints n/a for null and undefined', () => {
    expect(formatCost(null)).toBe('n/a');
    expect(formatCost(undefined)).toBe('n/a');
  });

  test('a true zero prints as $0.0000', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  test('a positive cost that would round to zero never reads as free', () => {
    expect(formatCost(0.00001)).toBe('<$0.0001');
  });
});

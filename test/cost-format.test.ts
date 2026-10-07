import { costBreakdownLine, formatCost, formatLogCost, metricsLines, metricsWindowParams } from '../src/cost-format.js';
import type { LlmMetrics } from 'coolhand-node';

describe('formatCost', () => {
  test('renders 4 decimals', () => {
    expect(formatCost(1.23456)).toBe('1.2346');
    expect(formatCost(0)).toBe('0.0000');
  });

  test('renders n/a for null or undefined, so a zero cost is never confused with an unpriced one', () => {
    expect(formatCost(null)).toBe('n/a');
    expect(formatCost(undefined)).toBe('n/a');
  });
});

describe('formatLogCost', () => {
  test('matches formatCost for values that survive 4-decimal rounding and for unknown costs', () => {
    expect(formatLogCost(1.23456)).toBe('1.2346');
    expect(formatLogCost(0.00006)).toBe('0.0001');
    expect(formatLogCost(0)).toBe('0.0000');
    expect(formatLogCost(null)).toBe('n/a');
    expect(formatLogCost(undefined)).toBe('n/a');
  });

  test('marks a priced cost that would round to zero as <0.0001, never 0.0000', () => {
    expect(formatLogCost(0.00004)).toBe('<0.0001');
    expect(formatLogCost(0.0000001)).toBe('<0.0001');
  });
});

describe('metricsWindowParams', () => {
  test('returns only the window fields that were given', () => {
    expect(metricsWindowParams({})).toEqual({});
    expect(metricsWindowParams({ daysBack: 7, since: 'a', until: 'b' })).toEqual({ daysBack: 7, since: 'a', until: 'b' });
  });

  test('does not leak unrelated option fields', () => {
    const opts = { daysBack: 3, search: 'x', json: true } as Parameters<typeof metricsWindowParams>[0];
    expect(metricsWindowParams(opts)).toEqual({ daysBack: 3 });
  });
});

describe('metricsLines', () => {
  const metrics = {
    since: 's',
    until: 'u',
    request_count: 5,
    failure_count: 1,
    total_cost: null,
    priced_request_count: 0,
    total_input_tokens: 10,
    total_output_tokens: 20,
  } as LlmMetrics;

  test('summarises window, requests, cost and tokens', () => {
    expect(metricsLines(metrics)).toEqual([
      'Window: s to u',
      'Requests: 5  Failures: 1',
      'Total cost (USD): n/a  Priced requests: 0',
      'Input tokens: 10  Output tokens: 20',
    ]);
  });
});

describe('costBreakdownLine', () => {
  test('marks a priced component under $0.0001 instead of showing 0.0000', () => {
    const line = costBreakdownLine({
      total_cost: 0.00004,
      input_cost: 0.00003,
      output_cost: 0.00001,
      cached_input_cost: 0,
      cache_creation_input_cost: 0,
      reasoning_output_cost: 0,
    });
    expect(line).toBe(
      'Cost breakdown (USD): input <0.0001, output <0.0001, cached input 0.0000, cache creation 0.0000, reasoning output 0.0000'
    );
  });

  test('lists every component to 4 decimals', () => {
    const line = costBreakdownLine({
      total_cost: 0.3,
      input_cost: 0.1,
      output_cost: 0.2,
      cached_input_cost: 0,
      cache_creation_input_cost: 0,
      reasoning_output_cost: 0.00006,
    });
    expect(line).toBe(
      'Cost breakdown (USD): input 0.1000, output 0.2000, cached input 0.0000, cache creation 0.0000, reasoning output 0.0001'
    );
  });
});

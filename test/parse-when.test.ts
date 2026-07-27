import { parseWhen } from '../src/parse-when.js';
import { CliError } from '../src/errors.js';

describe('parseWhen', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  test('parses Nh shorthand relative to the injected now', () => {
    expect(parseWhen('12h', { now, boundary: 'start' })).toEqual(new Date('2026-07-13T00:00:00.000Z'));
  });

  test('parses Nd shorthand relative to the injected now', () => {
    expect(parseWhen('7d', { now, boundary: 'start' })).toEqual(new Date('2026-07-06T12:00:00.000Z'));
  });

  test('parses Nw shorthand relative to the injected now', () => {
    expect(parseWhen('2w', { now, boundary: 'start' })).toEqual(new Date('2026-06-29T12:00:00.000Z'));
  });

  test('parses YYYY-MM-DD as local start of day for the start boundary', () => {
    const parsed = parseWhen('2026-06-01', { now, boundary: 'start' });
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
    expect(parsed.getMilliseconds()).toBe(0);
  });

  test('parses YYYY-MM-DD as local end of day for the end boundary', () => {
    const parsed = parseWhen('2026-06-01', { now, boundary: 'end' });
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(23);
    expect(parsed.getMinutes()).toBe(59);
    expect(parsed.getSeconds()).toBe(59);
    expect(parsed.getMilliseconds()).toBe(999);
  });

  test('parses a full ISO datetime verbatim', () => {
    expect(parseWhen('2026-06-15T08:30:00.000Z', { now, boundary: 'start' })).toEqual(
      new Date('2026-06-15T08:30:00.000Z')
    );
  });

  test('throws INVALID_ARGS on garbage input, naming the accepted formats', () => {
    expect(() => parseWhen('yesterday-ish', { now, boundary: 'start' })).toThrow(CliError);
    try {
      parseWhen('yesterday-ish', { now, boundary: 'start' });
    } catch (err) {
      expect((err as CliError).code).toBe('INVALID_ARGS');
      expect((err as CliError).message).toMatch(/YYYY-MM-DD/);
    }
  });

  test('throws INVALID_ARGS on an empty string', () => {
    expect(() => parseWhen('', { now, boundary: 'start' })).toThrow(CliError);
  });

  test('rejects a zero-length duration unit without a count', () => {
    expect(() => parseWhen('d', { now, boundary: 'start' })).toThrow(CliError);
  });

  test('rejects an out-of-range day of month instead of silently rolling over', () => {
    // JS `Date` normalizes Feb 30 into Mar 2 rather than throwing; parseWhen must catch this.
    expect(() => parseWhen('2026-02-30', { now, boundary: 'start' })).toThrow(CliError);
  });

  test('rejects an out-of-range month instead of silently rolling over', () => {
    expect(() => parseWhen('2026-13-01', { now, boundary: 'start' })).toThrow(CliError);
  });

  test('rejects a day that overflows into the next month for the end boundary too', () => {
    expect(() => parseWhen('2026-06-31', { now, boundary: 'end' })).toThrow(CliError);
  });
});

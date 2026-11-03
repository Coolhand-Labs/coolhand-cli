import { selectUpdate, parseStable, BAKE_PERIOD_MS, type Packument } from '../../src/auto-update/select.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();

function packument(
  latest: string,
  releases: Record<string, { ageHours: number; deprecated?: string }>
): Packument {
  return {
    'dist-tags': { latest },
    time: Object.fromEntries(Object.entries(releases).map(([v, r]) => [v, hoursAgo(r.ageHours)])),
    versions: Object.fromEntries(
      Object.entries(releases).map(([v, r]) => [v, r.deprecated ? { deprecated: r.deprecated } : {}])
    ),
  };
}

describe('parseStable', () => {
  test('parses plain versions and rejects prereleases and build metadata', () => {
    expect(parseStable('1.22.3')).toEqual([1, 22, 3]);
    expect(parseStable('1.2.3-beta.1')).toBeNull();
    expect(parseStable('1.2.3+build')).toBeNull();
    expect(parseStable('1.2')).toBeNull();
    expect(parseStable('')).toBeNull();
  });
});

describe('selectUpdate', () => {
  test('picks the highest release past the bake period', () => {
    const p = packument('0.14.0', {
      '0.12.0': { ageHours: 500 },
      '0.13.0': { ageHours: 100 },
      '0.14.0': { ageHours: 49 },
    });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW })).toBe('0.14.0');
  });

  test('skips releases younger than 48 hours and falls back to the newest baked one', () => {
    const p = packument('0.14.0', {
      '0.12.0': { ageHours: 500 },
      '0.13.0': { ageHours: 72 },
      '0.14.0': { ageHours: 47.9 },
    });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW })).toBe('0.13.0');
  });

  test('a release exactly at the bake boundary is eligible', () => {
    const p = packument('0.13.0', { '0.12.0': { ageHours: 500 }, '0.13.0': { ageHours: 48 } });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW, bakeMs: BAKE_PERIOD_MS })).toBe('0.13.0');
  });

  test('ignores prereleases and deprecated versions', () => {
    const p = packument('0.15.0', {
      '0.12.0': { ageHours: 500 },
      '0.13.0': { ageHours: 100, deprecated: 'broken, use 0.13.1' },
      '0.14.0-beta.1': { ageHours: 100 },
      '0.15.0': { ageHours: 10 },
    });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW })).toBeNull();
  });

  test('never goes above the latest dist-tag (a rolled-back tag stops a bad release)', () => {
    const p = packument('0.13.0', {
      '0.12.0': { ageHours: 500 },
      '0.13.0': { ageHours: 100 },
      '0.14.0': { ageHours: 100 },
    });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW })).toBe('0.13.0');
  });

  test('never downgrades or returns the current version', () => {
    const p = packument('0.12.0', { '0.11.0': { ageHours: 900 }, '0.12.0': { ageHours: 500 } });
    expect(selectUpdate(p, { current: '0.12.0', now: NOW })).toBeNull();
    expect(selectUpdate(p, { current: '0.13.0', now: NOW })).toBeNull();
  });

  test('compares numerically, not lexically', () => {
    const p = packument('0.10.0', { '0.9.0': { ageHours: 500 }, '0.10.0': { ageHours: 500 } });
    expect(selectUpdate(p, { current: '0.9.0', now: NOW })).toBe('0.10.0');
  });

  test('returns null for missing publish times, missing latest, or an unparsable current', () => {
    expect(selectUpdate({ 'dist-tags': { latest: '0.13.0' }, versions: { '0.13.0': {} } }, { current: '0.12.0', now: NOW })).toBeNull();
    expect(selectUpdate({}, { current: '0.12.0', now: NOW })).toBeNull();
    expect(selectUpdate(packument('0.13.0', { '0.13.0': { ageHours: 100 } }), { current: 'dev', now: NOW })).toBeNull();
  });
});

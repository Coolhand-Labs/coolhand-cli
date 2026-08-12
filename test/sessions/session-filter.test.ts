import { buildSessionFilter, sanitizeProjectKey, type SessionFileMeta } from '../../src/sessions/session-filter.js';

const meta = (overrides: Partial<SessionFileMeta> = {}): SessionFileMeta => ({
  sessionId: 'sess-1',
  project: 'C--Users-Mubar-Downloads-Coolhand-labs-coop-coolhand-coolhand-cli',
  mtimeMs: new Date('2026-07-01T00:00:00.000Z').getTime(),
  source: 'claude-code',
  ...overrides,
});

describe('sanitizeProjectKey', () => {
  test('lowercases and collapses non-alphanumerics to single dashes', () => {
    expect(sanitizeProjectKey('Coolhand Labs/CLI__v2')).toBe('coolhand-labs-cli-v2');
  });

  test('collapses the double dashes of encoded project folder names', () => {
    expect(sanitizeProjectKey('C--Users-Mubar-Downloads-Coolhand-labs-coop-coolhand-coolhand-cli')).toBe(
      'c-users-mubar-downloads-coolhand-labs-coop-coolhand-coolhand-cli'
    );
  });
});

describe('buildSessionFilter', () => {
  test('no criteria accepts everything', () => {
    const filter = buildSessionFilter({});
    expect(filter(meta())).toBe(true);
    expect(filter(meta({ project: null, source: 'cowork' }))).toBe(true);
  });

  test('includeProjects keeps only matching projects (substring on sanitized names)', () => {
    const filter = buildSessionFilter({ includeProjects: ['coolhand-cli'] });
    expect(filter(meta())).toBe(true);
    expect(filter(meta({ project: 'C--Users-Mubar-other-repo' }))).toBe(false);
  });

  test('includeProjects excludes sessions with no project (Cowork)', () => {
    const filter = buildSessionFilter({ includeProjects: ['coolhand-cli'] });
    expect(filter(meta({ project: null, source: 'cowork' }))).toBe(false);
  });

  test('excludeProjects drops matching projects and keeps the rest', () => {
    const filter = buildSessionFilter({ excludeProjects: ['coolhand-cli'] });
    expect(filter(meta())).toBe(false);
    expect(filter(meta({ project: 'C--Users-Mubar-other-repo' }))).toBe(true);
  });

  test('excludeProjects drops projectless sessions (Cowork), failing closed', () => {
    const filter = buildSessionFilter({ excludeProjects: ['coolhand-cli'] });
    expect(filter(meta({ project: null, source: 'cowork' }))).toBe(false);
  });

  test('excludeProjects unset leaves projectless sessions (Cowork) unaffected', () => {
    const filter = buildSessionFilter({});
    expect(filter(meta({ project: null, source: 'cowork' }))).toBe(true);
  });

  test('exclude wins over include when both match', () => {
    const filter = buildSessionFilter({
      includeProjects: ['coolhand'],
      excludeProjects: ['coolhand-cli'],
    });
    expect(filter(meta())).toBe(false);
  });

  test('untilMs drops files modified after the bound and keeps the bound itself', () => {
    const boundary = new Date('2026-07-01T00:00:00.000Z').getTime();
    const filter = buildSessionFilter({ untilMs: boundary });
    expect(filter(meta({ mtimeMs: boundary }))).toBe(true);
    expect(filter(meta({ mtimeMs: boundary + 1 }))).toBe(false);
  });

  test('sinceMs drops files modified before the bound and keeps the bound itself', () => {
    const boundary = new Date('2026-07-01T00:00:00.000Z').getTime();
    const filter = buildSessionFilter({ sinceMs: boundary });
    expect(filter(meta({ mtimeMs: boundary }))).toBe(true);
    expect(filter(meta({ mtimeMs: boundary - 1 }))).toBe(false);
  });

  test('criteria compose: project include + time window', () => {
    const filter = buildSessionFilter({
      includeProjects: ['coolhand-cli'],
      untilMs: new Date('2026-07-02T00:00:00.000Z').getTime(),
    });
    expect(filter(meta())).toBe(true);
    expect(filter(meta({ mtimeMs: new Date('2026-07-03T00:00:00.000Z').getTime() }))).toBe(false);
    expect(filter(meta({ project: 'C--Users-Mubar-other-repo' }))).toBe(false);
  });

  test('match is case-insensitive via sanitization', () => {
    const filter = buildSessionFilter({ includeProjects: ['Coolhand-CLI'] });
    expect(filter(meta())).toBe(true);
  });
});

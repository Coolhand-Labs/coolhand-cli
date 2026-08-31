import {
  FEATURE_FLAGS_ENV,
  parseGroups,
  enabledGroups,
  blockingGroup,
  visibleCommands,
} from '../src/feature-flags.js';

describe('parseGroups', () => {
  test('returns an empty list for an empty string', () => {
    expect(parseGroups('')).toEqual([]);
  });

  test('parses a single group', () => {
    expect(parseGroups('workloads')).toEqual(['workloads']);
  });

  test('parses multiple comma-separated groups', () => {
    expect(parseGroups('workloads,optimizations')).toEqual(['workloads', 'optimizations']);
  });

  test('trims whitespace and drops empty entries', () => {
    expect(parseGroups(' workloads , optimizations ,, ')).toEqual(['workloads', 'optimizations']);
  });
});

describe('enabledGroups', () => {
  beforeEach(() => {
    delete process.env[FEATURE_FLAGS_ENV];
  });

  afterEach(() => {
    delete process.env[FEATURE_FLAGS_ENV];
  });

  test('is empty when neither the env var nor the config field is set', () => {
    expect(enabledGroups({})).toEqual(new Set());
  });

  test('falls back to the config file when the env var is unset', () => {
    expect(enabledGroups({ feature_flags: ['workloads'] })).toEqual(new Set(['workloads']));
  });

  test('uses the env var when it is set', () => {
    process.env[FEATURE_FLAGS_ENV] = 'workloads,optimizations';
    expect(enabledGroups({})).toEqual(new Set(['workloads', 'optimizations']));
  });

  test('lets the env var override the config file', () => {
    process.env[FEATURE_FLAGS_ENV] = 'optimizations';
    expect(enabledGroups({ feature_flags: ['workloads'] })).toEqual(new Set(['optimizations']));
  });

  test('treats an explicitly empty env var as "everything off", ignoring the file', () => {
    process.env[FEATURE_FLAGS_ENV] = '';
    expect(enabledGroups({ feature_flags: ['workloads'] })).toEqual(new Set());
  });

  test('ignores an empty config array', () => {
    expect(enabledGroups({ feature_flags: [] })).toEqual(new Set());
  });
});

describe('blockingGroup', () => {
  test('never gates a command without a feature group', () => {
    expect(blockingGroup({}, new Set())).toBeNull();
    expect(blockingGroup({}, new Set(['workloads']))).toBeNull();
  });

  test('allows a command whose group is enabled', () => {
    expect(blockingGroup({ featureGroup: 'workloads' }, new Set(['workloads']))).toBeNull();
  });

  test('returns the blocking group when the group is not enabled', () => {
    expect(blockingGroup({ featureGroup: 'workloads' }, new Set())).toBe('workloads');
    expect(blockingGroup({ featureGroup: 'workloads' }, new Set(['optimizations']))).toBe('workloads');
  });
});

describe('visibleCommands', () => {
  const commands = [
    { name: 'login' },
    { name: 'list-workloads', featureGroup: 'workloads' },
    { name: 'search-optimizations', featureGroup: 'optimizations' },
  ];

  test('hides gated commands and keeps ungated ones when nothing is enabled', () => {
    expect(visibleCommands(commands, new Set()).map((c) => c.name)).toEqual(['login']);
  });

  test('reveals a group once it is enabled', () => {
    expect(visibleCommands(commands, new Set(['workloads'])).map((c) => c.name)).toEqual([
      'login',
      'list-workloads',
    ]);
  });

  test('reveals every command when all groups are enabled', () => {
    const enabled = new Set(['workloads', 'optimizations']);
    expect(visibleCommands(commands, enabled).map((c) => c.name)).toEqual([
      'login',
      'list-workloads',
      'search-optimizations',
    ]);
  });
});

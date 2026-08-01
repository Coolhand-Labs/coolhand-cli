jest.mock('../src/proxy/proxy.js', () => ({
  startProxy: jest.fn(),
}));
jest.mock('../src/proxy/certs.js', () => ({
  getOrCreateCA: jest.fn(),
  getCertPath: jest.fn(),
}));
jest.mock('../src/commands/claude.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/monitor.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/search-optimizations.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/search-feedback.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/get-feedback.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/analyze-claude-sessions.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/flush-pending.js', () => ({
  run: jest.fn().mockResolvedValue(0),
  spawnBackgroundFlush: jest.fn(),
}));
jest.mock('../src/prompt.js', () => ({ confirm: jest.fn().mockResolvedValue(false) }));

import { parseArgs, peelClientId, run } from '../src/cli.js';
import { CliError } from '../src/errors.js';
import { logger } from '../src/logger.js';
import { run as runFlushPending, spawnBackgroundFlush } from '../src/commands/flush-pending.js';
import { confirm } from '../src/prompt.js';
import { markFlushFailed, savePendingRecord } from '../src/pending-store.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';
import { run as runClaudeCommand } from '../src/commands/claude.js';
import { run as runMonitorCommand } from '../src/commands/monitor.js';
import { run as runSearchOptimizationsCommand } from '../src/commands/search-optimizations.js';
import { run as runSearchFeedbackCommand } from '../src/commands/search-feedback.js';
import { run as runGetFeedbackCommand } from '../src/commands/get-feedback.js';
import { run as runAnalyzeClaudeSessions } from '../src/commands/analyze-claude-sessions.js';

function makePending() {
  return savePendingRecord({
    command: 'report-blocker',
    kind: 'feedback' as const,
    payload: { explanation: 'x', creator_type: 'agent' as const },
    savedAt: '2026-06-29T12:00:00.000Z',
  });
}

describe('parseArgs', () => {
  test('extracts subcommand and flags', () => {
    const parsed = parseArgs(['login', '--base-url', 'https://x', '--json']);
    expect(parsed.command).toBe('login');
    expect(parsed.flags['base-url']).toBe('https://x');
    expect(parsed.flags.json).toBe(true);
  });

  test('supports = syntax', () => {
    const parsed = parseArgs(['login', '--base-url=https://x']);
    expect(parsed.flags['base-url']).toBe('https://x');
  });

  test('captures positional arguments', () => {
    const parsed = parseArgs(['clients', 'use', 'acme']);
    expect(parsed.command).toBe('clients');
    expect(parsed.positional).toEqual(['use', 'acme']);
  });

  test('treats short flag as boolean', () => {
    const parsed = parseArgs(['--version']);
    expect(parsed.flags.version).toBe(true);
  });

  test('does not consume positional id after boolean flag', () => {
    const parsed = parseArgs(['get-optimization', '--json', 'opt-1']);
    expect(parsed.command).toBe('get-optimization');
    expect(parsed.flags.json).toBe(true);
    expect(parsed.positional).toEqual(['opt-1']);
  });

  test('preserves multi-word positional text', () => {
    const parsed = parseArgs(['close-optimization', 'opt-1', 'looks', 'good']);
    expect(parsed.command).toBe('close-optimization');
    expect(parsed.positional).toEqual(['opt-1', 'looks', 'good']);
  });

  test('space-separated flag value starting with a dash is NOT consumed (use --flag=value instead)', () => {
    const parsed = parseArgs(['update-workload', '--description', '-1 fix']);
    expect(parsed.flags.description).toBe(true);
  });

  test('--flag=value syntax correctly captures a value starting with a dash', () => {
    const parsed = parseArgs(['update-workload', '--description=-1 fix']);
    expect(parsed.flags.description).toBe('-1 fix');
  });

  test('a single repeatable flag occurrence stays a string', () => {
    const parsed = parseArgs(['analyze-claude-sessions', '--project', 'coolhand-cli']);
    expect(parsed.flags.project).toBe('coolhand-cli');
  });

  test('repeated --project flags accumulate into an array in order', () => {
    const parsed = parseArgs(['analyze-claude-sessions', '--project', 'p1', '--project', 'p2', '--project', 'p3']);
    expect(parsed.flags.project).toEqual(['p1', 'p2', 'p3']);
  });

  test('repeatable flags accumulate across = and space syntaxes', () => {
    const parsed = parseArgs(['analyze-claude-sessions', '--exclude-project=p1', '--exclude-project', 'p2']);
    expect(parsed.flags['exclude-project']).toEqual(['p1', 'p2']);
  });

  test('a repeated non-repeatable flag still keeps only the last value', () => {
    const parsed = parseArgs(['login', '--base-url', 'https://a', '--base-url', 'https://b']);
    expect(parsed.flags['base-url']).toBe('https://b');
  });

  test('analyze-claude-sessions filter flags are mapped into command options', async () => {
    (runAnalyzeClaudeSessions as jest.Mock).mockClear();
    await run([
      'analyze-claude-sessions',
      '--dry-run',
      '--since', '7d',
      '--until', '2026-06-30',
      '--projects-dir', 'C:/tmp/projects',
      '--project', 'alpha',
      '--project', 'beta,gamma',
      '--exclude-project', 'secret',
    ]);
    expect(runAnalyzeClaudeSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        since: '7d',
        until: '2026-06-30',
        projectsDir: 'C:/tmp/projects',
        projects: ['alpha', 'beta', 'gamma'],
        excludeProjects: ['secret'],
      })
    );
  });
});

describe('run', () => {
  let home: TmpHome;
  let warnSpy: jest.SpyInstance;
  beforeEach(async () => {
    home = await createTmpHome();
    (runClaudeCommand as jest.Mock).mockResolvedValue(0);
    (runMonitorCommand as jest.Mock).mockResolvedValue(0);
    (runSearchOptimizationsCommand as jest.Mock).mockResolvedValue(0);
    (runSearchFeedbackCommand as jest.Mock).mockResolvedValue(0);
    (runGetFeedbackCommand as jest.Mock).mockResolvedValue(0);
    (runFlushPending as jest.Mock).mockClear().mockResolvedValue(0);
    (spawnBackgroundFlush as jest.Mock).mockClear();
    (confirm as jest.Mock).mockReset().mockResolvedValue(false);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    await home.cleanup();
    (runClaudeCommand as jest.Mock).mockReset();
    (runMonitorCommand as jest.Mock).mockReset();
    (runSearchOptimizationsCommand as jest.Mock).mockReset();
    (runSearchFeedbackCommand as jest.Mock).mockReset();
    (runGetFeedbackCommand as jest.Mock).mockReset();
    warnSpy.mockRestore();
  });

  test('--version exits 0', async () => {
    const code = await run(['--version']);
    expect(code).toBe(0);
  });

  test('unknown command exits with USER_ERROR', async () => {
    const code = await run(['frobnicate']);
    expect(code).toBe(1);
  });

  test('status with no config exits 1', async () => {
    const code = await run(['status', '--json']);
    expect(code).toBe(1);
  });

  test('help exits 0', async () => {
    const code = await run(['help']);
    expect(code).toBe(0);
  });

  test('login --write-env without path returns INVALID_ARGS', async () => {
    const code = await run(['login', '--write-env']);
    expect(code).toBe(1);
  });

  test('get-optimization without id returns exit 1', async () => {
    const code = await run(['get-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization without id returns exit 1', async () => {
    const code = await run(['close-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization with id but no reason returns exit 1', async () => {
    const code = await run(['close-optimization', 'abc-123']);
    expect(code).toBe(1);
  });

  test('update-optimization without id returns exit 1', async () => {
    const code = await run(['update-optimization']);
    expect(code).toBe(1);
  });

  test('get-workload without --id returns exit 1', async () => {
    const code = await run(['get-workload']);
    expect(code).toBe(1);
  });

  test('update-workload without --id returns exit 1', async () => {
    const code = await run(['update-workload', '--name', 'New name']);
    expect(code).toBe(1);
  });

  test('update-workload with --id but no --name/--description returns exit 1', async () => {
    const code = await run(['update-workload', '--id', 'wl-1']);
    expect(code).toBe(1);
  });

  test('update-workload with trailing --name (no value) returns exit 1 with a specific error', async () => {
    const spy = jest.spyOn(logger, 'info');
    const code = await run(['update-workload', '--id', 'wl-1', '--name']);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--name requires a value'));
    spy.mockRestore();
  });

  test('update-workload with --description value starting with a dash uses --description=VALUE, not silent drop', async () => {
    const spy = jest.spyOn(logger, 'info');
    const code = await run(['update-workload', '--id', 'wl-1', '--description', '-1 fix']);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--description requires a value'));
    spy.mockRestore();
  });

  test('update-workload with empty --name returns exit 1', async () => {
    const code = await run(['update-workload', '--id', 'wl-1', '--name', '']);
    expect(code).toBe(1);
  });

  test('fetch-log without <log-id> returns exit 1', async () => {
    const code = await run(['fetch-log']);
    expect(code).toBe(1);
  });

  test('fetch-log with invalid --section returns exit 1', async () => {
    const code = await run(['fetch-log', 'log-1', '--section', 'middle']);
    expect(code).toBe(1);
  });

  test('fetch-log with non-numeric --max-chars returns exit 1', async () => {
    const code = await run(['fetch-log', 'log-1', '--max-chars', 'lots']);
    expect(code).toBe(1);
  });

  test('fetch-log with --search-query and --section returns exit 1', async () => {
    const code = await run(['fetch-log', 'log-1', '--search-query', 'error', '--section', 'beginning']);
    expect(code).toBe(1);
  });

  test('fetch-log with --search-query and --max-chars returns exit 1', async () => {
    const code = await run(['fetch-log', 'log-1', '--search-query', 'error', '--max-chars', '500']);
    expect(code).toBe(1);
  });

  test('search-logs with non-numeric --page returns exit 1', async () => {
    const code = await run(['search-logs', '--page', 'abc']);
    expect(code).toBe(1);
  });

  test('search-logs with --per-page over 100 returns exit 1', async () => {
    const code = await run(['search-logs', '--per-page', '101']);
    expect(code).toBe(1);
  });

  test('search-logs with non-numeric --days-back returns exit 1', async () => {
    const code = await run(['search-logs', '--days-back', 'abc']);
    expect(code).toBe(1);
  });

  test('global --client-id with no value returns exit 1', async () => {
    const code = await run(['--client-id']);
    expect(code).toBe(1);
  });

  test('global --client-id= with empty value returns exit 1', async () => {
    const code = await run(['--client-id=', 'status']);
    expect(code).toBe(1);
  });

  test('global --client-id is merged and forwarded to the dispatched command', async () => {
    const code = await run(['--client-id', 'acme', 'search-optimizations']);
    expect(code).toBe(0);
    expect(runSearchOptimizationsCommand).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'acme' })
    );
  });

  test('global --client-id is forwarded to the claude passthrough', async () => {
    const code = await run(['--client-id', 'acme', 'claude', '--resume']);
    expect(code).toBe(0);
    expect(runClaudeCommand).toHaveBeenCalledWith({ args: ['--resume'], clientId: 'acme' });
  });

  test('global --client-id is forwarded to the monitor passthrough', async () => {
    const code = await run(['--client-id', 'acme', 'monitor', 'kimi', '--resume']);
    expect(code).toBe(0);
    expect(runMonitorCommand).toHaveBeenCalledWith({ command: 'kimi', args: ['--resume'], clientId: 'acme' });
  });

  test('monitor strips a leading -- before the wrapped command', async () => {
    const code = await run(['monitor', '--', 'kimi', '--resume']);
    expect(code).toBe(0);
    expect(runMonitorCommand).toHaveBeenCalledWith({ command: 'kimi', args: ['--resume'], clientId: undefined });
  });

  test('monitor with no command exits with USER_ERROR', async () => {
    const code = await run(['monitor']);
    expect(code).toBe(1);
    expect(runMonitorCommand).not.toHaveBeenCalled();
  });

  test('monitor with only -- and no command exits with USER_ERROR', async () => {
    const code = await run(['monitor', '--']);
    expect(code).toBe(1);
    expect(runMonitorCommand).not.toHaveBeenCalled();
  });

  test('warns when both global and per-command --client-id are supplied (per-command wins)', async () => {
    const code = await run(['--client-id', 'global', 'search-optimizations', '--client-id', 'per']);
    expect(code).toBe(0);
    expect(runSearchOptimizationsCommand).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'per' })
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  test('suppresses duplicate --client-id warning in JSON mode to protect machine consumers', async () => {
    const code = await run(['--client-id', 'global', 'search-optimizations', '--client-id', 'per', '--json']);
    expect(code).toBe(0);
    expect(runSearchOptimizationsCommand).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'per' })
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('suppresses duplicate --client-id warning when both flags carry the same value', async () => {
    const code = await run(['--client-id', 'acme', 'search-optimizations', '--client-id', 'acme']);
    expect(code).toBe(0);
    expect(runSearchOptimizationsCommand).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'acme' })
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('hidden __flush-pending command dispatches to the flush worker', async () => {
    const code = await run(['__flush-pending']);
    expect(code).toBe(0);
    expect(runFlushPending).toHaveBeenCalled();
  });

  test('failed-flush reminder offers retry and launches background flush on yes', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status']);

    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).toHaveBeenCalled();
  });

  test('failed-flush reminder does not launch flush when the user declines', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(false);

    await run(['status']);

    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('no failed-flush reminder when there was no prior failure', async () => {
    await makePending(); // records exist, but no failed marker
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status']);

    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('failed-flush reminder is skipped in --json mode', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['status', '--json']);

    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('failed-flush reminder is skipped for --version', async () => {
    await makePending();
    await markFlushFailed();
    (confirm as jest.Mock).mockResolvedValue(true);

    await run(['--version']);

    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('search-feedback dispatches with parsed flags', async () => {
    const code = await run([
      'search-feedback',
      '--sentiment', 'positive',
      '--matched',
      '--sort-by', 'created_at',
      '--page', '2',
      '--per-page', '10',
      '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runSearchFeedbackCommand).toHaveBeenCalledWith({
      sentiment: 'positive',
      matched: true,
      sortBy: 'created_at',
      page: 2,
      perPage: 10,
      clientId: 'acme',
    });
  });

  test('search-feedback rejects an invalid --sentiment value', async () => {
    const code = await run(['search-feedback', '--sentiment', 'bogus']);
    expect(code).toBe(1);
    expect(runSearchFeedbackCommand).not.toHaveBeenCalled();
  });

  test('search-feedback rejects --matched combined with --unmatched', async () => {
    const code = await run(['search-feedback', '--matched', '--unmatched']);
    expect(code).toBe(1);
    expect(runSearchFeedbackCommand).not.toHaveBeenCalled();
  });

  test('search-feedback rejects an out-of-range --per-page', async () => {
    const code = await run(['search-feedback', '--per-page', '101']);
    expect(code).toBe(1);
    expect(runSearchFeedbackCommand).not.toHaveBeenCalled();
  });

  test('get-feedback requires a positional <feedback-id>', async () => {
    const code = await run(['get-feedback']);
    expect(code).toBe(1);
    expect(runGetFeedbackCommand).not.toHaveBeenCalled();
  });

  test('get-feedback dispatches with the id and flags', async () => {
    const code = await run(['get-feedback', 'fb-123', '--json', '--client-id', 'acme']);
    expect(code).toBe(0);
    expect(runGetFeedbackCommand).toHaveBeenCalledWith({ id: 'fb-123', json: true, clientId: 'acme' });
  });

});

describe('peelClientId', () => {
  test('strips --client-id VALUE before a positional command', () => {
    expect(peelClientId(['--client-id', 'acme', 'list-workloads'])).toEqual({
      clientId: 'acme',
      rest: ['list-workloads'],
    });
  });

  test('strips --client-id=VALUE before a positional command', () => {
    expect(peelClientId(['--client-id=acme', 'list-workloads'])).toEqual({
      clientId: 'acme',
      rest: ['list-workloads'],
    });
  });

  test('leaves argv unchanged when no --client-id is present', () => {
    expect(peelClientId(['list-workloads', '--json'])).toEqual({
      clientId: undefined,
      rest: ['list-workloads', '--json'],
    });
  });

  test('stops peeling at the first positional (command name)', () => {
    expect(peelClientId(['list-workloads', '--client-id', 'acme'])).toEqual({
      clientId: undefined,
      rest: ['list-workloads', '--client-id', 'acme'],
    });
  });

  test('preserves other leading flags', () => {
    expect(peelClientId(['--json', '--client-id', 'acme', 'status'])).toEqual({
      clientId: 'acme',
      rest: ['--json', 'status'],
    });
  });

  test('throws INVALID_ARGS when --client-id appears with no following value', () => {
    expect(() => peelClientId(['--client-id'])).toThrow(CliError);
    expect(() => peelClientId(['--client-id'])).toThrow('--client-id requires a value');
  });

  test('throws INVALID_ARGS when --client-id= has an empty value', () => {
    expect(() => peelClientId(['--client-id='])).toThrow(CliError);
    expect(() => peelClientId(['--client-id='])).toThrow('non-empty');
  });

  test('throws INVALID_ARGS when --client-id value looks like a flag', () => {
    expect(() => peelClientId(['--client-id', '--json', 'status'])).toThrow(CliError);
    expect(() => peelClientId(['--client-id', '--json', 'status'])).toThrow('--json');
  });

  test('throws INVALID_ARGS when --client-id=VALUE uses a flag-like value', () => {
    expect(() => peelClientId(['--client-id=--json', 'status'])).toThrow(CliError);
    expect(() => peelClientId(['--client-id=--json', 'status'])).toThrow('--json');
  });

  test('throws INVALID_ARGS when --client-id appears twice before the command', () => {
    expect(() => peelClientId(['--client-id', 'foo', '--client-id', 'bar', 'status'])).toThrow(CliError);
    expect(() => peelClientId(['--client-id', 'foo', '--client-id', 'bar', 'status'])).toThrow('more than once');
  });

  test('stops at -- and passes everything from -- onward to rest unchanged', () => {
    expect(peelClientId(['--', 'list-workloads'])).toEqual({
      clientId: undefined,
      rest: ['--', 'list-workloads'],
    });
  });

  test('stops at -- even when --client-id appears after it (not peeled)', () => {
    expect(peelClientId(['--', '--client-id', 'acme', 'list-workloads'])).toEqual({
      clientId: undefined,
      rest: ['--', '--client-id', 'acme', 'list-workloads'],
    });
  });

  test('passes -- and trailing args to rest when -- follows --client-id', () => {
    expect(peelClientId(['--client-id', 'acme', '--'])).toEqual({
      clientId: 'acme',
      rest: ['--'],
    });
  });
});

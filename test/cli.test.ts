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
jest.mock('../src/commands/search-logs.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/link-feedback.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/search-templates.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/get-template.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/search-help-articles.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/get-help-article.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/list-help-categories.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/search-workloads.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/search-referenced-files.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/list-referenced-file-sessions.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/upload-client-file.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/list-client-files.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/download-client-file.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/update-client-file.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/map-claude-projects.js', () => ({
  run: jest.fn(),
}));
jest.mock('../src/commands/analyze-claude-sessions.js', () => ({
  run: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/commands/capture-turn.js', () => ({
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
import { run as runSearchLogsCommand } from '../src/commands/search-logs.js';
import { run as runLinkFeedbackCommand } from '../src/commands/link-feedback.js';
import { run as runSearchTemplatesCommand } from '../src/commands/search-templates.js';
import { run as runGetTemplateCommand } from '../src/commands/get-template.js';
import { run as runSearchHelpArticlesCommand } from '../src/commands/search-help-articles.js';
import { run as runGetHelpArticleCommand } from '../src/commands/get-help-article.js';
import { run as runListHelpCategoriesCommand } from '../src/commands/list-help-categories.js';
import { run as runSearchWorkloadsCommand } from '../src/commands/search-workloads.js';
import { run as runSearchReferencedFilesCommand } from '../src/commands/search-referenced-files.js';
import { run as runListReferencedFileSessionsCommand } from '../src/commands/list-referenced-file-sessions.js';
import { run as runUploadClientFileCommand } from '../src/commands/upload-client-file.js';
import { run as runListClientFilesCommand } from '../src/commands/list-client-files.js';
import { run as runDownloadClientFileCommand } from '../src/commands/download-client-file.js';
import { run as runUpdateClientFileCommand } from '../src/commands/update-client-file.js';
import { run as runMapClaudeProjectsCommand } from '../src/commands/map-claude-projects.js';
import { run as runAnalyzeClaudeSessions } from '../src/commands/analyze-claude-sessions.js';
import { run as runCaptureTurnCommand } from '../src/commands/capture-turn.js';

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
    (runLinkFeedbackCommand as jest.Mock).mockResolvedValue(0);
    (runSearchTemplatesCommand as jest.Mock).mockResolvedValue(0);
    (runGetTemplateCommand as jest.Mock).mockResolvedValue(0);
    (runSearchHelpArticlesCommand as jest.Mock).mockResolvedValue(0);
    (runGetHelpArticleCommand as jest.Mock).mockResolvedValue(0);
    (runListHelpCategoriesCommand as jest.Mock).mockResolvedValue(0);
    (runSearchWorkloadsCommand as jest.Mock).mockResolvedValue(0);
    (runSearchLogsCommand as jest.Mock).mockResolvedValue(0);
    (runSearchReferencedFilesCommand as jest.Mock).mockResolvedValue(0);
    (runListReferencedFileSessionsCommand as jest.Mock).mockResolvedValue(0);
    (runUploadClientFileCommand as jest.Mock).mockResolvedValue(0);
    (runMapClaudeProjectsCommand as jest.Mock).mockResolvedValue(0);
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
    (runLinkFeedbackCommand as jest.Mock).mockReset();
    (runSearchTemplatesCommand as jest.Mock).mockReset();
    (runGetTemplateCommand as jest.Mock).mockReset();
    (runSearchHelpArticlesCommand as jest.Mock).mockReset();
    (runGetHelpArticleCommand as jest.Mock).mockReset();
    (runListHelpCategoriesCommand as jest.Mock).mockReset();
    (runSearchWorkloadsCommand as jest.Mock).mockReset();
    (runSearchLogsCommand as jest.Mock).mockReset();
    (runSearchReferencedFilesCommand as jest.Mock).mockReset();
    (runListReferencedFileSessionsCommand as jest.Mock).mockReset();
    (runUploadClientFileCommand as jest.Mock).mockReset();
    (runMapClaudeProjectsCommand as jest.Mock).mockReset();
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

  test('search-optimizations with non-numeric --page returns exit 1', async () => {
    const code = await run(['search-optimizations', '--page', 'abc']);
    expect(code).toBe(1);
  });

  test('search-optimizations with --per-page over 50 returns exit 1', async () => {
    const code = await run(['search-optimizations', '--per-page', '51']);
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

  test('search-logs --include-total is boolean and does not swallow a following token', async () => {
    (runSearchLogsCommand as jest.Mock).mockClear();
    await run(['search-logs', '--include-total', '--per-page', '5']);
    expect(runSearchLogsCommand).toHaveBeenCalledWith(expect.objectContaining({ includeTotal: true, perPage: 5 }));
  });

  test('search-logs omits includeTotal by default', async () => {
    (runSearchLogsCommand as jest.Mock).mockClear();
    await run(['search-logs']);
    expect(runSearchLogsCommand).toHaveBeenCalledWith(expect.not.objectContaining({ includeTotal: true }));
  });

  test('search-templates with an invalid --status returns exit 1', async () => {
    const code = await run(['search-templates', '--status', 'archived']);
    expect(code).toBe(1);
  });

  test('search-templates with --per-page over 100 returns exit 1', async () => {
    const code = await run(['search-templates', '--per-page', '101']);
    expect(code).toBe(1);
  });

  test('search-templates with non-numeric --page returns exit 1', async () => {
    const code = await run(['search-templates', '--page', 'abc']);
    expect(code).toBe(1);
  });

  test('search-templates forwards its filter flags to the command', async () => {
    const code = await run([
      'search-templates',
      '--search', 'summar',
      '--workload-id', 'wl-1',
      '--status', 'published',
      '--include-deprecated',
      '--include-system',
      '--page', '2',
      '--per-page', '50',
    ]);
    expect(code).toBe(0);
    expect(runSearchTemplatesCommand).toHaveBeenCalledWith({
      search: 'summar',
      workloadId: 'wl-1',
      status: 'published',
      includeDeprecated: true,
      includeSystem: true,
      page: 2,
      perPage: 50,
    });
  });

  test('--include-deprecated and --include-system parse as booleans, not value flags', async () => {
    await run(['search-templates', '--include-deprecated', '--include-system']);
    expect(runSearchTemplatesCommand).toHaveBeenCalledWith({
      includeDeprecated: true,
      includeSystem: true,
    });
  });

  test('search-workloads forwards its flags to the command', async () => {
    const code = await run([
      'search-workloads',
      '--search', 'agent',
      '--include-archived',
      '--include-system',
      '--include-templates',
      '--include-metrics',
      '--days-back', '7',
      '--since', '2026-09-01T00:00:00+02:00',
      '--until', '2026-10-01',
      '--page', '2',
      '--per-page', '50',
      '--client-id', 'acme',
      '--json',
    ]);
    expect(code).toBe(0);
    expect(runSearchWorkloadsCommand).toHaveBeenCalledWith({
      search: 'agent',
      includeArchived: true,
      includeSystem: true,
      includeTemplates: true,
      includeMetrics: true,
      daysBack: 7,
      since: '2026-09-01T00:00:00+02:00',
      until: '2026-10-01',
      page: 2,
      perPage: 50,
      clientId: 'acme',
      json: true,
    });
  });

  test('--include-metrics parses as a boolean, not a value flag', async () => {
    await run(['search-workloads', '--include-metrics', '--days-back', '3']);
    expect(runSearchWorkloadsCommand).toHaveBeenCalledWith({ includeMetrics: true, daysBack: 3 });
  });

  test.each([
    ['--days-back', '0'],
    ['--days-back', '1.5'],
    ['--days-back', 'abc'],
    ['--page', '0'],
    ['--per-page', '101'],
  ])('search-workloads rejects %s %s with exit 1', async (flag, value) => {
    const code = await run(['search-workloads', flag, value]);
    expect(code).toBe(1);
    expect(runSearchWorkloadsCommand).not.toHaveBeenCalled();
  });

  test('search-workloads rejects --since with no value', async () => {
    const code = await run(['search-workloads', '--since']);
    expect(code).toBe(1);
  });

  test('search-templates forwards metrics flags', async () => {
    await run(['search-templates', '--include-metrics', '--days-back', '7', '--since', '2026-09-01', '--until', '2026-10-01']);
    expect(runSearchTemplatesCommand).toHaveBeenCalledWith({
      includeMetrics: true,
      daysBack: 7,
      since: '2026-09-01',
      until: '2026-10-01',
    });
  });

  test('search-templates rejects a non-positive --days-back', async () => {
    expect(await run(['search-templates', '--days-back', '0'])).toBe(1);
  });

  test('get-template --no-metrics and window flags are forwarded', async () => {
    await run(['get-template', 'tmpl-1', '--no-metrics', '--days-back', '14', '--since', '2026-09-01', '--until', '2026-10-01']);
    expect(runGetTemplateCommand).toHaveBeenCalledWith({
      id: 'tmpl-1',
      noMetrics: true,
      daysBack: 14,
      since: '2026-09-01',
      until: '2026-10-01',
    });
  });

  test('search-logs forwards the cost flags, sending --min-cost 0', async () => {
    await run([
      'search-logs',
      '--since', '2026-09-01T00:00:00+02:00',
      '--until', '2026-10-01',
      '--min-cost', '0',
      '--order', 'cost_desc',
      '--project-path', '/work/app',
      '--source-application', 'claude-code',
    ]);
    expect(runSearchLogsCommand).toHaveBeenCalledWith({
      since: '2026-09-01T00:00:00+02:00',
      until: '2026-10-01',
      minCost: 0,
      order: 'cost_desc',
      projectPath: '/work/app',
      sourceApplication: 'claude-code',
    });
  });

  test('search-logs parses a decimal --min-cost', async () => {
    await run(['search-logs', '--min-cost', '0.25']);
    expect(runSearchLogsCommand).toHaveBeenCalledWith({ minCost: 0.25 });
  });

  test.each(['abc', '-1', '1e3', '.5', ''])('search-logs rejects --min-cost %p with exit 1', async (value) => {
    const code = await run(['search-logs', `--min-cost=${value}`]);
    expect(code).toBe(1);
    expect(runSearchLogsCommand).not.toHaveBeenCalled();
  });

  test('search-logs does not allowlist --order client-side', async () => {
    await run(['search-logs', '--order', 'bogus']);
    expect(runSearchLogsCommand).toHaveBeenCalledWith({ order: 'bogus' });
  });

  test('get-template without <template-id> returns exit 1', async () => {
    const code = await run(['get-template']);
    expect(code).toBe(1);
  });

  test('get-template forwards the positional id to the command', async () => {
    const code = await run(['get-template', 'tmpl-1', '--json']);
    expect(code).toBe(0);
    expect(runGetTemplateCommand).toHaveBeenCalledWith({ id: 'tmpl-1', json: true });
  });

  test('search-help-articles with no args lists everything (no query sent)', async () => {
    const code = await run(['search-help-articles']);
    expect(code).toBe(0);
    expect(runSearchHelpArticlesCommand).toHaveBeenCalledWith({});
  });

  test('search-help-articles takes positional text as the query', async () => {
    await run(['search-help-articles', 'prompt', 'caching']);
    expect(runSearchHelpArticlesCommand).toHaveBeenCalledWith({ query: 'prompt caching' });
  });

  test('search-help-articles rejects --query combined with positional text', async () => {
    const code = await run(['search-help-articles', '--query', 'a', 'b']);
    expect(code).not.toBe(0);
    expect(runSearchHelpArticlesCommand).not.toHaveBeenCalled();
  });

  test('search-help-articles rejects a --query with no value (e.g. a leading-dash query)', async () => {
    const code = await run(['search-help-articles', '--query', '-openai']);
    expect(code).not.toBe(0);
    expect(runSearchHelpArticlesCommand).not.toHaveBeenCalled();
  });

  test('search-help-articles forwards --query, --category, paging, --base-url and --json', async () => {
    await run([
      'search-help-articles',
      '--query', 'anthropic',
      '--category', 'providers',
      '--page', '2',
      '--per-page', '10',
      '--base-url', 'http://127.0.0.1:3111',
      '--json',
    ]);
    expect(runSearchHelpArticlesCommand).toHaveBeenCalledWith({
      query: 'anthropic',
      category: 'providers',
      page: 2,
      perPage: 10,
      baseUrl: 'http://127.0.0.1:3111',
      json: true,
    });
  });

  test('search-help-articles treats a blank --query as omitted', async () => {
    await run(['search-help-articles', '--query', '  ']);
    expect(runSearchHelpArticlesCommand).toHaveBeenCalledWith({});
  });

  test('search-help-articles with --per-page over 100 returns exit 1', async () => {
    const code = await run(['search-help-articles', '--per-page', '101']);
    expect(code).toBe(1);
    expect(runSearchHelpArticlesCommand).not.toHaveBeenCalled();
  });

  test('search-help-articles with non-numeric --page returns exit 1', async () => {
    const code = await run(['search-help-articles', '--page', 'abc']);
    expect(code).toBe(1);
    expect(runSearchHelpArticlesCommand).not.toHaveBeenCalled();
  });

  test('get-help-article without <slug> returns exit 1', async () => {
    const code = await run(['get-help-article']);
    expect(code).toBe(1);
    expect(runGetHelpArticleCommand).not.toHaveBeenCalled();
  });

  test('get-help-article forwards the positional slug to the command', async () => {
    const code = await run(['get-help-article', 'what-is-feedback-match-rate', '--json']);
    expect(code).toBe(0);
    expect(runGetHelpArticleCommand).toHaveBeenCalledWith({ slug: 'what-is-feedback-match-rate', json: true });
  });

  test('list-help-categories forwards --client-id and --json', async () => {
    await run(['list-help-categories', '--client-id', 'acme', '--json']);
    expect(runListHelpCategoriesCommand).toHaveBeenCalledWith({ clientId: 'acme', json: true });
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

  test('link-feedback requires an <optimization-id>', async () => {
    const code = await run(['link-feedback']);
    expect(code).toBe(1);
    expect(runLinkFeedbackCommand).not.toHaveBeenCalled();
  });

  test('link-feedback dispatches with ids, --file=- and --note', async () => {
    const code = await run(['link-feedback', 'opt-1', 'fb-1', 'fb-2', '--file=-', '--note', 'why', '--json', '--client-id', 'acme']);
    expect(code).toBe(0);
    expect(runLinkFeedbackCommand).toHaveBeenCalledWith({
      optimizationId: 'opt-1', feedbackIds: ['fb-1', 'fb-2'], file: '-', note: 'why', json: true, clientId: 'acme',
    });
  });

  test('link-feedback rejects a bare --file with no path', async () => {
    const code = await run(['link-feedback', 'opt-1', '--file']);
    expect(code).toBe(1);
    expect(runLinkFeedbackCommand).not.toHaveBeenCalled();
  });

  test('search-referenced-files dispatches with parsed flags', async () => {
    const code = await run([
      'search-referenced-files',
      '--file-path-contains', 'routes',
      '--created-at-gteq', '2026-01-01T00:00:00Z',
      '--created-at-lteq', '2026-09-01T00:00:00Z',
      '--page', '2',
      '--per-page', '10',
      '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runSearchReferencedFilesCommand).toHaveBeenCalledWith({
      filePathContains: 'routes',
      createdAtGteq: '2026-01-01T00:00:00Z',
      createdAtLteq: '2026-09-01T00:00:00Z',
      page: 2,
      perPage: 10,
      clientId: 'acme',
    });
  });

  test('search-referenced-files with non-numeric --page returns exit 1', async () => {
    const code = await run(['search-referenced-files', '--page', 'abc']);
    expect(code).toBe(1);
    expect(runSearchReferencedFilesCommand).not.toHaveBeenCalled();
  });

  test('search-referenced-files rejects an out-of-range --per-page', async () => {
    const code = await run(['search-referenced-files', '--per-page', '101']);
    expect(code).toBe(1);
    expect(runSearchReferencedFilesCommand).not.toHaveBeenCalled();
  });

  test('list-referenced-file-sessions requires --file-path', async () => {
    const code = await run(['list-referenced-file-sessions']);
    expect(code).toBe(1);
    expect(runListReferencedFileSessionsCommand).not.toHaveBeenCalled();
  });

  test('list-referenced-file-sessions dispatches with the file path and flags', async () => {
    const code = await run([
      'list-referenced-file-sessions',
      '--file-path', 'config/routes.rb',
      '--page', '2',
      '--per-page', '10',
      '--json', '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runListReferencedFileSessionsCommand).toHaveBeenCalledWith({
      filePath: 'config/routes.rb',
      page: 2,
      perPage: 10,
      json: true,
      clientId: 'acme',
    });
  });

  test('list-referenced-file-sessions rejects an out-of-range --per-page', async () => {
    const code = await run(['list-referenced-file-sessions', '--file-path', 'x.rb', '--per-page', '101']);
    expect(code).toBe(1);
    expect(runListReferencedFileSessionsCommand).not.toHaveBeenCalled();
  });

  test('upload-client-file requires a positional <file-path>', async () => {
    const code = await run(['upload-client-file']);
    expect(code).toBe(1);
    expect(runUploadClientFileCommand).not.toHaveBeenCalled();
  });

  test('upload-client-file rejects an invalid --file-type value', async () => {
    const code = await run(['upload-client-file', 'report.pdf', '--file-type', 'bogus']);
    expect(code).toBe(1);
    expect(runUploadClientFileCommand).not.toHaveBeenCalled();
  });

  test('upload-client-file dispatches with the file path and flags', async () => {
    const code = await run([
      'upload-client-file', 'report.pdf',
      '--name', 'My Report',
      '--file-type', 'report',
      '--description', 'desc',
      '--json', '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runUploadClientFileCommand).toHaveBeenCalledWith({
      filePath: 'report.pdf',
      name: 'My Report',
      fileType: 'report',
      description: 'desc',
      json: true,
      clientId: 'acme',
    });
  });

  test('list-client-files rejects an invalid --status value', async () => {
    const code = await run(['list-client-files', '--status', 'failure']);
    expect(code).toBe(1);
    expect(runListClientFilesCommand).not.toHaveBeenCalled();
  });

  test('list-client-files rejects an invalid --file-type value', async () => {
    const code = await run(['list-client-files', '--file-type', 'bogus']);
    expect(code).toBe(1);
    expect(runListClientFilesCommand).not.toHaveBeenCalled();
  });

  test('list-client-files rejects a non-numeric --page and an out-of-range --per-page', async () => {
    expect(await run(['list-client-files', '--page', 'abc'])).toBe(1);
    expect(await run(['list-client-files', '--per-page', '101'])).toBe(1);
    expect(runListClientFilesCommand).not.toHaveBeenCalled();
  });

  test('list-client-files dispatches with its filter flags', async () => {
    const code = await run([
      'list-client-files', '--status', 'draft', '--file-type', 'report',
      '--page', '2', '--per-page', '10', '--json', '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runListClientFilesCommand).toHaveBeenCalledWith({
      status: 'draft', fileType: 'report', page: 2, perPage: 10, json: true, clientId: 'acme',
    });
  });

  test('download-client-file requires a positional <file-id>', async () => {
    const code = await run(['download-client-file']);
    expect(code).toBe(1);
    expect(runDownloadClientFileCommand).not.toHaveBeenCalled();
  });

  test('download-client-file dispatches with the id, --output and --force', async () => {
    const code = await run(['download-client-file', 'abc123', '--output', '/tmp/x.bin', '--force', '--json', '--client-id', 'acme']);
    expect(code).toBe(0);
    expect(runDownloadClientFileCommand).toHaveBeenCalledWith({
      id: 'abc123', output: '/tmp/x.bin', force: true, json: true, clientId: 'acme',
    });
  });

  test.each([[['--output']], [['--output', '']]])('download-client-file rejects a missing --output value %j', async (...[flagArgs]) => {
    (runDownloadClientFileCommand as jest.Mock).mockClear();
    const code = await run(['download-client-file', 'abc123', ...flagArgs]);
    expect(code).toBe(1);
    expect(runDownloadClientFileCommand).not.toHaveBeenCalled();
  });

  test('update-client-file requires a positional <file-id>', async () => {
    const code = await run(['update-client-file', '--status', 'draft']);
    expect(code).toBe(1);
    expect(runUpdateClientFileCommand).not.toHaveBeenCalled();
  });

  test('update-client-file requires --status', async () => {
    const code = await run(['update-client-file', 'abc123']);
    expect(code).toBe(1);
    expect(runUpdateClientFileCommand).not.toHaveBeenCalled();
  });

  test('update-client-file rejects an invalid --status value', async () => {
    const code = await run(['update-client-file', 'abc123', '--status', 'deleted']);
    expect(code).toBe(1);
    expect(runUpdateClientFileCommand).not.toHaveBeenCalled();
  });

  test('update-client-file dispatches with the id and status', async () => {
    const code = await run(['update-client-file', 'abc123', '--status', 'archived', '--json', '--client-id', 'acme']);
    expect(code).toBe(0);
    expect(runUpdateClientFileCommand).toHaveBeenCalledWith({
      id: 'abc123', status: 'archived', json: true, clientId: 'acme',
    });
  });

  test('map-claude-projects dispatches with flags', async () => {
    const code = await run([
      'map-claude-projects',
      '--root', '/tmp/x',
      '--output', '/tmp/report.md',
      '--force',
      '--dry-run',
      '--json',
      '--client-id', 'acme',
    ]);
    expect(code).toBe(0);
    expect(runMapClaudeProjectsCommand).toHaveBeenCalledWith({
      root: '/tmp/x',
      output: '/tmp/report.md',
      force: true,
      dryRun: true,
      json: true,
      clientId: 'acme',
    });
  });

  test('capture-turn dispatches with its flags', async () => {
    const code = await run([
      'capture-turn',
      '--agent', 'claude',
      '--skill', 'qa-login',
      '--api-key', 'pk_test_123',
      '--base-url', 'http://127.0.0.1:9',
      '--anonymous',
    ]);
    expect(code).toBe(0);
    expect(runCaptureTurnCommand).toHaveBeenCalledWith({
      agent: 'claude',
      skill: 'qa-login',
      apiKey: 'pk_test_123',
      baseUrl: 'http://127.0.0.1:9',
      anonymous: true,
    });
  });

  test('capture-turn ignores --client-id and treats an empty --base-url as unset', async () => {
    (runCaptureTurnCommand as jest.Mock).mockClear();
    await run(['--client-id', 'acme', 'capture-turn', '--agent', 'claude', '--base-url=']);
    expect(runCaptureTurnCommand).toHaveBeenCalledWith({ agent: 'claude' });
  });

  test('capture-turn keeps the last --skill when the flag is repeated', async () => {
    (runCaptureTurnCommand as jest.Mock).mockClear();
    await run(['capture-turn', '--agent', 'claude', '--skill', 'first', '--skill', 'second']);
    expect(runCaptureTurnCommand).toHaveBeenCalledWith({ agent: 'claude', skill: 'second' });
  });

  test('capture-turn with a bad --agent stays silent and exits 0 when run by an agent (no TTY)', async () => {
    (runCaptureTurnCommand as jest.Mock).mockClear();
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect(await run(['capture-turn'])).toBe(0);
      expect(await run(['capture-turn', '--agent', 'vim'])).toBe(0);
      expect(info).not.toHaveBeenCalled();
      expect(runCaptureTurnCommand).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
      info.mockRestore();
    }
  });

  test('capture-turn with a bad --agent reports the error to a human at a terminal', async () => {
    (runCaptureTurnCommand as jest.Mock).mockClear();
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      expect(await run(['capture-turn', '--agent', 'vim'])).not.toBe(0);
      expect(runCaptureTurnCommand).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    }
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

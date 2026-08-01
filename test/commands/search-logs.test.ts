// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockSearchLogs = jest.fn();

jest.mock('../../src/api/log-client.js', () => ({
  getLogClient: jest.fn().mockResolvedValue({ searchLogs: mockSearchLogs }),
  mapLogHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-logs.js';
import { getLogClient } from '../../src/api/log-client.js';

const emptyPagination = { current_page: 1, per_page: 25, total_count: 0, total_pages: 0, has_next_page: false, has_prev_page: false };
const oneLogResult = {
  logs: [{ id: 'log-1', model: 'gpt-4o', source_api: 'openai' }],
  pagination: { ...emptyPagination, total_count: 1, total_pages: 1 },
};

describe('search-logs command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLogClient as jest.Mock).mockResolvedValue({ searchLogs: mockSearchLogs });
    mockSearchLogs.mockResolvedValue(oneLogResult);
  });

  test('calls searchLogs with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockSearchLogs).toHaveBeenCalledWith({});
  });

  test('passes provided filter flags through as camelCase SDK params', async () => {
    await run({
      templateId: 'tmpl-1',
      workloadId: 'wl-1',
      systemPromptContains: 'foo',
      userPromptContains: 'bar',
      model: 'gpt-4o',
      sourceApi: 'openai',
      sourceApiResult: 'failed',
      unmatchedOnly: true,
      daysBack: 14,
      includePrompts: true,
      sort: 'created_at desc',
      page: 2,
      perPage: 50,
    });
    expect(mockSearchLogs).toHaveBeenCalledWith({
      templateId: 'tmpl-1',
      workloadId: 'wl-1',
      systemPromptContains: 'foo',
      userPromptContains: 'bar',
      model: 'gpt-4o',
      sourceApi: 'openai',
      sourceApiResult: 'failed',
      unmatchedOnly: true,
      daysBack: 14,
      includePrompts: true,
      sort: 'created_at desc',
      page: 2,
      per: 50,
    });
  });

  test('omits unmatchedOnly and includePrompts when false', async () => {
    await run({ unmatchedOnly: false, includePrompts: false });
    expect(mockSearchLogs).toHaveBeenCalledWith({});
  });

  test('forwards --client-id to getLogClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getLogClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a pagination hint in text mode', async () => {
    mockSearchLogs.mockResolvedValue({
      logs: [{ id: '1' }, { id: '2' }],
      pagination: { current_page: 2, per_page: 25, total_count: 60, total_pages: 3, has_next_page: true, has_prev_page: true },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 3 (60 total)'));
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: oneLogResult });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getLogClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw when the SDK call fails', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapLogHttpError } = await import('../../src/api/log-client.js');
    (mapLogHttpError as jest.Mock).mockReturnValue(new CliError('LOG_ERROR', 'boom'));
    mockSearchLogs.mockRejectedValue(new Error('network down'));
    const code = await run({});
    expect(code).not.toBe(0);
  });
});

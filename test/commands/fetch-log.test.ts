// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockGetLogContent = jest.fn();

jest.mock('../../src/api/log-client.js', () => ({
  getLogClient: jest.fn().mockResolvedValue({ getLogContent: mockGetLogContent }),
  mapLogHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/fetch-log.js';
import { getLogClient } from '../../src/api/log-client.js';

const fullContent = { id: 'log-1', system_prompt: 'hi', user_prompt: 'hello', output: 'world' };

describe('fetch-log command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLogClient as jest.Mock).mockResolvedValue({ getLogContent: mockGetLogContent });
    mockGetLogContent.mockResolvedValue(fullContent);
  });

  test('calls getLogContent with section/maxChars/includeThinking when no --search-query given', async () => {
    const code = await run({ logId: 'log-1' });
    expect(code).toBe(0);
    expect(mockGetLogContent).toHaveBeenCalledWith('log-1', {
      section: undefined,
      maxChars: undefined,
      includeThinking: undefined,
    });
  });

  test('passes section/maxChars/includeThinking through when provided', async () => {
    await run({ logId: 'log-1', section: 'beginning', maxChars: 500, includeThinking: true });
    expect(mockGetLogContent).toHaveBeenCalledWith('log-1', {
      section: 'beginning',
      maxChars: 500,
      includeThinking: true,
    });
  });

  test('calls getLogContent with searchQuery/includeThinking when --search-query given, omitting section/maxChars', async () => {
    await run({ logId: 'log-1', searchQuery: 'error', includeThinking: true });
    expect(mockGetLogContent).toHaveBeenCalledWith('log-1', {
      searchQuery: 'error',
      includeThinking: true,
    });
  });

  test('forwards --client-id to getLogClient', async () => {
    await run({ logId: 'log-1', clientId: 'my-client' });
    expect(getLogClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('--json flag exits 0 on success', async () => {
    const code = await run({ logId: 'log-1', json: true });
    expect(code).toBe(0);
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ logId: 'log-1', json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: fullContent });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getLogClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({ logId: 'log-1' });
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw on a 404-mapped error', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapLogHttpError } = await import('../../src/api/log-client.js');
    (mapLogHttpError as jest.Mock).mockReturnValue(
      new CliError('LOG_ERROR', 'Log "bad-id" not found (or does not belong to this client).')
    );
    mockGetLogContent.mockRejectedValue(new Error('404'));
    const code = await run({ logId: 'bad-id' });
    expect(code).not.toBe(0);
  });
});

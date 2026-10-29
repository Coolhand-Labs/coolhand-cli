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

  test('prints cost and cost_breakdown when present', async () => {
    mockGetLogContent.mockResolvedValue({
      ...fullContent,
      cost: 0.5,
      cost_breakdown: { total_cost: 0.5, input_cost: 0.2, output_cost: 0.3 },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Cost: $0.5000');
    expect(output).toContain('input_cost: $0.2000');
    spy.mockRestore();
  });

  test('prints Cost: n/a when the log could not be priced', async () => {
    mockGetLogContent.mockResolvedValue({ ...fullContent, cost: null, cost_breakdown: null });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Cost: n/a');
    spy.mockRestore();
  });

  test('passes includeTurnMetrics through on both the content and search paths', async () => {
    await run({ logId: 'log-1', includeTurnMetrics: true });
    expect(mockGetLogContent).toHaveBeenLastCalledWith('log-1', expect.objectContaining({ includeTurnMetrics: true }));
    await run({ logId: 'log-1', searchQuery: 'error', includeTurnMetrics: true });
    expect(mockGetLogContent).toHaveBeenLastCalledWith('log-1', {
      searchQuery: 'error',
      includeThinking: undefined,
      includeTurnMetrics: true,
    });
  });

  test('prints a turn_metrics summary when requested and present, tolerating null token fields', async () => {
    mockGetLogContent.mockResolvedValue({
      ...fullContent,
      turn_metrics: [
        {
          index: 0,
          human: true,
          started_at: null,
          ended_at: null,
          assistant_requests: 3,
          tool_calls: 2,
          input_tokens: 100,
          output_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: 7,
        },
      ],
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1', includeTurnMetrics: true });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Turn metrics:');
    expect(output).toContain('#0 human: 3 requests, 2 tool calls, tokens 100 in / n/a out (cache n/a read / 7 created)');
    spy.mockRestore();
  });

  test('says turn metrics are n/a when requested but null (not an agent session)', async () => {
    mockGetLogContent.mockResolvedValue({ ...fullContent, turn_metrics: null });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1', includeTurnMetrics: true });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Turn metrics: n/a');
    spy.mockRestore();
  });

  test('says turn metrics were not returned when requested but the key is absent', async () => {
    mockGetLogContent.mockResolvedValue({ ...fullContent });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1', includeTurnMetrics: true });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Turn metrics: not returned by the server');
    spy.mockRestore();
  });

  test('prints no turn metrics section when not requested', async () => {
    mockGetLogContent.mockResolvedValue({ ...fullContent, turn_metrics: null });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ logId: 'log-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).not.toContain('Turn metrics');
    spy.mockRestore();
  });
});

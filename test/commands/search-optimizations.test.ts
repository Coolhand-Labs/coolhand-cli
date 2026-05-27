import { run } from '../../src/commands/search-optimizations.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue([{ id: '1', title: 'Test' }]),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('search-optimizations command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue([{ id: '1', title: 'Test' }]);
  });

  test('calls search_optimizations with no args when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('search_optimizations', {}, { clientId: undefined });
  });

  test('passes provided filter flags as args', async () => {
    const code = await run({ status: 'open', query: 'latency', from: '2024-01-01', json: true });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('search_optimizations', {
      status: 'open',
      query: 'latency',
      from: '2024-01-01',
    }, { clientId: undefined });
  });

  test('omits undefined filter flags from args', async () => {
    await run({ type: 'prompt' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ type: 'prompt' });
    expect(Object.keys(args)).not.toContain('status');
    expect(Object.keys(args)).not.toContain('query');
  });

  test('passes page and per_page as numeric args', async () => {
    await run({ page: 2, perPage: 50 });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ page: 2, per_page: 50 });
  });

  test('passes template_id and workload_id as args', async () => {
    await run({ templateId: 'tmpl-abc', workloadId: 'wl-xyz' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ template_id: 'tmpl-abc', workload_id: 'wl-xyz' });
  });

  test('passes days_back as numeric arg', async () => {
    await run({ daysBack: 14 });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ days_back: 14 });
  });

  test('prints pagination hint when response has total and page fields', async () => {
    const paginatedResult = { items: [{ id: '1' }], total: 135, page: 2, per_page: 20 };
    (mcpCall as jest.Mock).mockResolvedValue(paginatedResult);
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 7 (135 total)'));
    spy.mockRestore();
  });

  test('does not print pagination hint for plain array response', async () => {
    (mcpCall as jest.Mock).mockResolvedValue([{ id: '1' }]);
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const calls = spy.mock.calls.map(([msg]) => msg);
    expect(calls.every((msg) => !msg.includes('Page'))).toBe(true);
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });
});

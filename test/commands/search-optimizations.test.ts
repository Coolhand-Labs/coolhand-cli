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

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });
});

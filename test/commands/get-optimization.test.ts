import { run } from '../../src/commands/get-optimization.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ id: 'opt-1', title: 'Reduce latency' }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('get-optimization command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ id: 'opt-1', title: 'Reduce latency' });
  });

  test('calls get_optimization with the provided id', async () => {
    const code = await run({ id: 'opt-1' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('get_optimization', { id: 'opt-1' }, { clientId: undefined });
  });

  test('--json flag produces json output', async () => {
    const code = await run({ id: 'opt-1', json: true });
    expect(code).toBe(0);
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id' });
    expect(code).not.toBe(0);
  });
});

import { run } from '../../src/commands/close-optimization.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ ok: true }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('close-optimization command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ ok: true });
  });

  test('calls close_optimization with id and reason', async () => {
    const code = await run({ id: 'opt-1', reason: 'shipped' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('close_optimization', {
      id: 'opt-1',
      reason: 'shipped',
    }, { clientId: undefined });
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'opt-1', reason: 'done' });
    expect(code).not.toBe(0);
  });
});

import { run } from '../../src/commands/add-optimization-comment.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ ok: true }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('add-optimization-comment command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ ok: true });
  });

  test('calls add_optimization_comment with id and comment', async () => {
    const code = await run({ id: 'opt-1', comment: 'Looks good' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('add_optimization_comment', {
      id: 'opt-1',
      comment: 'Looks good',
    }, { clientId: undefined });
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Server error'));
    const code = await run({ id: 'opt-1', comment: 'test' });
    expect(code).not.toBe(0);
  });
});

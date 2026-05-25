import { run } from '../../src/commands/update-optimization.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ id: 'opt-1', title: 'Updated title' }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('update-optimization command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ id: 'opt-1', title: 'Updated title' });
  });

  test('calls update_optimization with id and flags', async () => {
    const code = await run({ id: 'opt-1', title: 'Updated title', plan: 'new plan' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('update_optimization', {
      id: 'opt-1',
      title: 'Updated title',
      plan: 'new plan',
    }, { clientId: undefined });
  });

  test('omits undefined optional flags', async () => {
    await run({ id: 'opt-1', analysis: 'updated analysis' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ id: 'opt-1', analysis: 'updated analysis' });
    expect(Object.keys(args)).not.toContain('title');
    expect(Object.keys(args)).not.toContain('plan');
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id' });
    expect(code).not.toBe(0);
  });

  test('--json flag exits 0 on success', async () => {
    const code = await run({ id: 'opt-1', json: true });
    expect(code).toBe(0);
  });

  test('--json flag exits non-zero on error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id', json: true });
    expect(code).not.toBe(0);
  });

  test('forwards --client-id to mcpCall', async () => {
    const code = await run({ id: 'opt-1', title: 'New title', clientId: 'my-client' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('update_optimization', {
      id: 'opt-1',
      title: 'New title',
    }, { clientId: 'my-client' });
  });
});

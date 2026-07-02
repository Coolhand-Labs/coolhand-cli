import { run } from '../../src/commands/update-workload.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ workload: { id: 'wl-1', name: 'Updated name' } }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('update-workload command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ workload: { id: 'wl-1', name: 'Updated name' } });
  });

  test('calls update_workload with workload_id and flags', async () => {
    const code = await run({ id: 'wl-1', name: 'Updated name', description: 'new desc' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('update_workload', {
      workload_id: 'wl-1',
      name: 'Updated name',
      description: 'new desc',
    }, { clientId: undefined });
  });

  test('omits undefined optional flags', async () => {
    await run({ id: 'wl-1', description: 'updated description' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ workload_id: 'wl-1', description: 'updated description' });
    expect(Object.keys(args)).not.toContain('name');
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Cannot rename system workloads'));
    const code = await run({ id: 'sys-1', name: 'New name' });
    expect(code).not.toBe(0);
  });

  test('--json flag exits 0 on success', async () => {
    const code = await run({ id: 'wl-1', name: 'X', json: true });
    expect(code).toBe(0);
  });

  test('--json flag exits non-zero on error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id', name: 'X', json: true });
    expect(code).not.toBe(0);
  });

  test('forwards --client-id to mcpCall', async () => {
    const code = await run({ id: 'wl-1', name: 'New name', clientId: 'my-client' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('update_workload', {
      workload_id: 'wl-1',
      name: 'New name',
    }, { clientId: 'my-client' });
  });
});

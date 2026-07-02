import { run } from '../../src/commands/get-workload.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ workload: { id: 'wl-1', name: 'My Workload' } }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('get-workload command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ workload: { id: 'wl-1', name: 'My Workload' } });
  });

  test('calls get_workload with workload_id', async () => {
    const code = await run({ id: 'wl-1' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('get_workload', { workload_id: 'wl-1' }, { clientId: undefined });
  });

  test('returns non-zero exit on MCP_ERROR', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id' });
    expect(code).not.toBe(0);
  });

  test('--json flag exits 0 on success', async () => {
    const code = await run({ id: 'wl-1', json: true });
    expect(code).toBe(0);
  });

  test('--json flag exits non-zero on error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id', json: true });
    expect(code).not.toBe(0);
  });

  test('forwards --client-id to mcpCall', async () => {
    const code = await run({ id: 'wl-1', clientId: 'my-client' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('get_workload', { workload_id: 'wl-1' }, { clientId: 'my-client' });
  });
});

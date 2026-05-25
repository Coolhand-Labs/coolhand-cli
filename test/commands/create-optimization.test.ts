import { run } from '../../src/commands/create-optimization.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ id: 'new-opt', title: 'Reduce p99' }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

describe('create-optimization command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue({ id: 'new-opt', title: 'Reduce p99' });
  });

  test('calls create_optimization with provided flags', async () => {
    const code = await run({ title: 'Reduce p99', analysis: 'slow', plan: 'cache it' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('create_optimization', {
      title: 'Reduce p99',
      analysis: 'slow',
      plan: 'cache it',
    }, { clientId: undefined });
  });

  test('omits undefined flags from args', async () => {
    await run({ title: 'Only title' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ title: 'Only title' });
    expect(Object.keys(args)).not.toContain('analysis');
    expect(Object.keys(args)).not.toContain('plan');
  });

  test('calls with empty args when no flags given', async () => {
    await run({});
    expect(mcpCall).toHaveBeenCalledWith('create_optimization', {}, { clientId: undefined });
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({ title: 'Test' });
    expect(code).not.toBe(0);
  });

  test('--json flag exits 0 on success', async () => {
    const code = await run({ title: 'My opt', json: true });
    expect(code).toBe(0);
  });

  test('forwards --client-id to mcpCall', async () => {
    const code = await run({ title: 'My opt', clientId: 'my-client' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('create_optimization', { title: 'My opt' }, { clientId: 'my-client' });
  });
});

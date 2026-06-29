import { run } from '../../src/commands/list-workloads.js';

jest.mock('../../src/commands/mcp-call.js', () => ({
  mcpCall: jest.fn().mockResolvedValue({ workloads: [], total: 0, page: 1, per_page: 25, total_pages: 0 }),
}));
import { mcpCall } from '../../src/commands/mcp-call.js';

const defaultResult = { workloads: [{ id: 'wl-1', name: 'My Workload' }], total: 1, page: 1, per_page: 25, total_pages: 1 };

describe('list-workloads command', () => {
  beforeEach(() => {
    (mcpCall as jest.Mock).mockReset().mockResolvedValue(defaultResult);
  });

  test('calls list_workloads with no args when no options given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('list_workloads', {}, { clientId: undefined });
  });

  test('passes search as arg', async () => {
    await run({ search: 'prod' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ search: 'prod' });
  });

  test('passes page and per_page as numeric args', async () => {
    await run({ page: 2, perPage: 50 });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ page: 2, per_page: 50 });
  });

  test('passes include_archived and include_system as boolean args', async () => {
    await run({ includeArchived: true, includeSystem: true });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ include_archived: true, include_system: true });
  });

  test('omits undefined flags from args', async () => {
    await run({ search: 'test' });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args)).not.toContain('page');
    expect(Object.keys(args)).not.toContain('per_page');
    expect(Object.keys(args)).not.toContain('include_archived');
  });

  test('computes totalPages from total/per_page and shows navigation hint', async () => {
    // total=100, per_page=25 → Math.ceil(100/25) = 4 pages; total_pages field is ignored
    (mcpCall as jest.Mock).mockResolvedValue({ workloads: [], total: 100, page: 2, per_page: 25, total_pages: 999 });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 4 (100 total)'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('--page N to navigate'));
    spy.mockRestore();
  });

  test('suppresses pagination hint when per_page is absent', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ workloads: [], total: 50, page: 1 });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const calls = spy.mock.calls.map(([msg]) => msg);
    expect(calls.every((msg) => !String(msg).includes('Page'))).toBe(true);
    spy.mockRestore();
  });

  test('does not print pagination hint for plain array response', async () => {
    (mcpCall as jest.Mock).mockResolvedValue([{ id: 'wl-1' }]);
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const calls = spy.mock.calls.map(([msg]) => msg);
    expect(calls.every((msg) => !String(msg).includes('Page'))).toBe(true);
    spy.mockRestore();
  });

  test('emits JSON output when json flag set', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ json: true });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    spy.mockRestore();
  });

  test('returns non-zero exit and logs error on CliError', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('passes include_templates when flag set', async () => {
    await run({ includeTemplates: true });
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({ include_templates: true });
  });

  test('omits include_templates when flag not set', async () => {
    await run({});
    const [, args] = (mcpCall as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args)).not.toContain('include_templates');
  });

  test('renders templates array in workload output', async () => {
    const template = { id: 'tpl-1', name: 'My Template', status: 'active', user_prompt_pattern: 'optimize.*cost', system_prompt_pattern: null };
    (mcpCall as jest.Mock).mockResolvedValue({ workloads: [{ id: 'wl-1', name: 'My Workload', templates: [template] }], total: 1, page: 1, per_page: 25 });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ includeTemplates: true });
    const output = spy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(output).toContain('user_prompt_pattern');
    spy.mockRestore();
  });

  test('returns non-zero exit and emits JSON error when json flag set on CliError', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'something failed'));
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'MCP_ERROR' }));
    spy.mockRestore();
  });
});

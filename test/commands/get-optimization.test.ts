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

  test('--json flag exits non-zero on error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mcpCall as jest.Mock).mockRejectedValue(new CliError('MCP_ERROR', 'Not found'));
    const code = await run({ id: 'bad-id', json: true });
    expect(code).not.toBe(0);
  });

  test('prints PR line when pr_number and pr_url are present', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ id: 'opt-1', title: 'Reduce latency', pr_number: 42, pr_url: 'https://github.com/org/repo/pull/42' });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    expect(spy).toHaveBeenCalledWith('PR: #42 https://github.com/org/repo/pull/42');
    spy.mockRestore();
  });

  test('prints coding_prompt as raw block when present', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ id: 'opt-1', title: 'Reduce latency', coding_prompt: 'Fix the slow query\nby adding an index' });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Fix the slow query\nby adding an index'));
    spy.mockRestore();
  });

  test('does not print PR line or coding_prompt block when fields absent', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ id: 'opt-1', title: 'Reduce latency' });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    const calls = spy.mock.calls.map(([msg]) => msg as string);
    expect(calls.every((msg) => !msg.startsWith('PR:'))).toBe(true);
    expect(calls.every((msg) => !msg.includes('Coding Prompt'))).toBe(true);
    spy.mockRestore();
  });

  test('forwards --client-id to mcpCall', async () => {
    const code = await run({ id: 'opt-1', clientId: 'my-client' });
    expect(code).toBe(0);
    expect(mcpCall).toHaveBeenCalledWith('get_optimization', { id: 'opt-1' }, { clientId: 'my-client' });
  });

  test('prints known summary fields when present', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({
      id: 'opt-1',
      title: 'Reduce latency',
      status: 'proposed',
      impact: 'high_impact',
      complexity: 'medium_complexity',
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    const calls = spy.mock.calls.map(([msg]) => msg as string);
    expect(calls).toContain('Title: Reduce latency');
    expect(calls).toContain('Status: proposed');
    expect(calls).toContain('Impact: high_impact');
    expect(calls).toContain('Complexity: medium_complexity');
    spy.mockRestore();
  });

  test('unwraps a nested { optimization: {...} } response', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ optimization: { id: 'opt-1', title: 'Reduce latency' } });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    const calls = spy.mock.calls.map(([msg]) => msg as string);
    expect(calls).toContain('Title: Reduce latency');
    spy.mockRestore();
  });

  test('does not print orchestrator_messages in default text mode', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({
      id: 'opt-1',
      title: 'Reduce latency',
      orchestrator_messages: [{ role: 'tool', thoughtSignature: 'abc123' }],
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1' });
    const calls = spy.mock.calls.map(([msg]) => msg as string);
    expect(calls.every((msg) => !msg.includes('thoughtSignature'))).toBe(true);
    expect(calls.every((msg) => !msg.includes('Orchestrator Messages'))).toBe(true);
    spy.mockRestore();
  });

  test('strips orchestrator_messages from default --json output', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({
      optimization: { id: 'opt-1', title: 'Reduce latency', orchestrator_messages: [{ thoughtSignature: 'abc123' }] },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'opt-1', json: true });
    const payload = spy.mock.calls[0][0] as { result: { optimization: Record<string, unknown> } };
    expect(payload.result.optimization.orchestrator_messages).toBeUndefined();
    spy.mockRestore();
  });

  test('--full includes orchestrator_messages in --json output', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({
      optimization: { id: 'opt-1', title: 'Reduce latency', orchestrator_messages: [{ thoughtSignature: 'abc123' }] },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'opt-1', json: true, full: true });
    const payload = spy.mock.calls[0][0] as { result: { optimization: Record<string, unknown> } };
    expect(payload.result.optimization.orchestrator_messages).toEqual([{ thoughtSignature: 'abc123' }]);
    spy.mockRestore();
  });

  test('--full text mode prints orchestrator_messages block', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({
      id: 'opt-1',
      title: 'Reduce latency',
      orchestrator_messages: [{ thoughtSignature: 'abc123' }],
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'opt-1', full: true });
    const calls = spy.mock.calls.map(([msg]) => msg as string);
    expect(calls.some((msg) => msg.includes('Orchestrator Messages') && msg.includes('thoughtSignature'))).toBe(true);
    spy.mockRestore();
  });

  test('prints Next steps footer in text mode but not in --json mode', async () => {
    (mcpCall as jest.Mock).mockResolvedValue({ id: 'opt-1', title: 'Reduce latency' });
    const { logger } = await import('../../src/logger.js');
    const infoSpy = jest.spyOn(logger, 'info');
    const jsonSpy = jest.spyOn(logger, 'json');

    await run({ id: 'opt-1' });
    const textCalls = infoSpy.mock.calls.map(([msg]) => msg as string);
    expect(textCalls.some((msg) => msg.includes('Next steps:') && msg.includes('close-optimization opt-1'))).toBe(true);

    infoSpy.mockClear();
    jsonSpy.mockClear();
    await run({ id: 'opt-1', json: true });
    expect(infoSpy).not.toHaveBeenCalled();
    const payload = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(payload).not.toContain('Next steps');

    infoSpy.mockRestore();
    jsonSpy.mockRestore();
  });
});

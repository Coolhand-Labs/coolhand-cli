// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockGetTemplate = jest.fn();

jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn().mockResolvedValue({ getTemplate: mockGetTemplate }),
  mapTemplateHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/get-template.js';
import { getTemplateClient } from '../../src/api/template-client.js';

const longPattern = `^(?:${'a|'.repeat(400)}z)$`;

const detail = {
  id: 'tmpl-1',
  name: 'Summarizer',
  status: 'published',
  version: '3',
  group: 'chat',
  workload_id: 'wl-1',
  workload_name: 'Support',
  system_template: false,
  deprecated_at: null,
  log_count: 12,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  user_prompt_pattern: longPattern,
  system_prompt_pattern: String.raw`^You are a helpful assistant\.$`,
};

describe('get-template command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTemplateClient as jest.Mock).mockResolvedValue({ getTemplate: mockGetTemplate });
    mockGetTemplate.mockResolvedValue(detail);
  });

  test('calls getTemplate with the given id', async () => {
    const code = await run({ id: 'tmpl-1' });
    expect(code).toBe(0);
    expect(mockGetTemplate).toHaveBeenCalledWith('tmpl-1');
  });

  test('forwards --client-id to getTemplateClient', async () => {
    await run({ id: 'tmpl-1', clientId: 'my-client' });
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a human-readable summary including workload and log count', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'tmpl-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('ID: tmpl-1');
    expect(output).toContain('Name: Summarizer');
    expect(output).toContain('Workload: Support');
    expect(output).toContain('Log count: 12');
    spy.mockRestore();
  });

  test('prints system_template so a system bucket is identifiable', async () => {
    mockGetTemplate.mockResolvedValue({ ...detail, name: 'Unmatched', system_template: true });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'sys-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('System template: true');
    spy.mockRestore();
  });

  test('prints both prompt patterns in full, untruncated', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'tmpl-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('User Prompt Pattern');
    expect(output).toContain(longPattern);
    expect(output).toContain('System Prompt Pattern');
    spy.mockRestore();
  });

  test('omits a pattern heading when that pattern is null', async () => {
    mockGetTemplate.mockResolvedValue({ ...detail, system_prompt_pattern: null });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'tmpl-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('User Prompt Pattern');
    expect(output).not.toContain('System Prompt Pattern');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'tmpl-1', json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: detail });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getTemplateClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({ id: 'tmpl-1' });
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw on a 404-mapped error', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapTemplateHttpError } = await import('../../src/api/template-client.js');
    (mapTemplateHttpError as jest.Mock).mockReturnValue(
      new CliError('TEMPLATE_ERROR', 'Template "missing" not found (or does not belong to this client).')
    );
    mockGetTemplate.mockRejectedValue(new Error('404'));
    const code = await run({ id: 'missing' });
    expect(code).not.toBe(0);
    expect(mapTemplateHttpError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('"missing"'),
      expect.any(String)
    );
  });
});

// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockSearchTemplates = jest.fn();

jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn().mockResolvedValue({ searchTemplates: mockSearchTemplates }),
  mapTemplateHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-templates.js';
import { getTemplateClient } from '../../src/api/template-client.js';

const emptyPagination = {
  current_page: 1,
  per_page: 25,
  total_count: 0,
  total_pages: 1,
  has_next_page: false,
  has_prev_page: false,
};

const oneTemplateResult = {
  templates: [
    {
      id: 'tmpl-1',
      name: 'Summarizer',
      status: 'published',
      version: '1',
      group: 'chat',
      workload_id: 'wl-1',
      workload_name: 'Support',
      system_template: false,
      deprecated_at: null,
      log_count: 12,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    },
  ],
  pagination: { ...emptyPagination, total_count: 1, total_pages: 1 },
};

describe('search-templates command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTemplateClient as jest.Mock).mockResolvedValue({ searchTemplates: mockSearchTemplates });
    mockSearchTemplates.mockResolvedValue(oneTemplateResult);
  });

  test('calls searchTemplates with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockSearchTemplates).toHaveBeenCalledWith({});
  });

  test('passes provided filter flags through as camelCase SDK params', async () => {
    await run({
      search: 'summar',
      workloadId: 'wl-1',
      status: 'published',
      includeDeprecated: true,
      includeSystem: true,
      page: 2,
      perPage: 50,
    });
    expect(mockSearchTemplates).toHaveBeenCalledWith({
      search: 'summar',
      workloadId: 'wl-1',
      status: 'published',
      includeDeprecated: true,
      includeSystem: true,
      page: 2,
      per: 50,
    });
  });

  test('sends --per-page as the SDK `per` knob, never `per_page`', async () => {
    await run({ perPage: 10 });
    expect(mockSearchTemplates).toHaveBeenCalledWith({ per: 10 });
  });

  test('omits includeDeprecated and includeSystem when false', async () => {
    await run({ includeDeprecated: false, includeSystem: false });
    expect(mockSearchTemplates).toHaveBeenCalledWith({});
  });

  test('preserves a literal % in --search rather than escaping it client-side', async () => {
    await run({ search: '100%_done' });
    expect(mockSearchTemplates).toHaveBeenCalledWith({ search: '100%_done' });
  });

  test('forwards --client-id to getTemplateClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a pagination hint in text mode', async () => {
    mockSearchTemplates.mockResolvedValue({
      templates: [{ id: '1' }, { id: '2' }],
      pagination: { current_page: 2, per_page: 25, total_count: 60, total_pages: 3, has_next_page: true, has_prev_page: true },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 3 (60 total)'));
    spy.mockRestore();
  });

  test('points at --include-system when the default list comes back empty', async () => {
    mockSearchTemplates.mockResolvedValue({ templates: [], pagination: emptyPagination });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('--include-system');
    spy.mockRestore();
  });

  test('does not suggest --include-system when it was already passed', async () => {
    mockSearchTemplates.mockResolvedValue({ templates: [], pagination: emptyPagination });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ includeSystem: true });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).not.toContain('--include-system');
    spy.mockRestore();
  });

  test('surfaces system_template on each row so system buckets are distinguishable', async () => {
    mockSearchTemplates.mockResolvedValue({
      templates: [
        { ...oneTemplateResult.templates[0], id: 'sys-1', name: 'Unmatched', system_template: true },
      ],
      pagination: { ...emptyPagination, total_count: 1 },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ includeSystem: true });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('"system_template": true');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: oneTemplateResult });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getTemplateClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('maps a failed SDK call through mapTemplateHttpError with a narrowing hint', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapTemplateHttpError } = await import('../../src/api/template-client.js');
    (mapTemplateHttpError as jest.Mock).mockReturnValue(new CliError('TEMPLATE_ERROR', 'timed out'));
    mockSearchTemplates.mockRejectedValue(new Error('gateway timeout'));
    const code = await run({});
    expect(code).not.toBe(0);
    expect(mapTemplateHttpError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.any(String),
      expect.stringContaining('--workload-id')
    );
  });
});

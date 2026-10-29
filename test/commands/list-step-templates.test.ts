// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement.
const mockListStepTemplates = jest.fn();

jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn().mockResolvedValue({ listStepTemplates: mockListStepTemplates }),
}));
jest.mock('../../src/api/step-template-client.js', () => ({
  mapStepTemplateHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/list-step-templates.js';
import { getTemplateClient } from '../../src/api/template-client.js';
import { mapStepTemplateHttpError } from '../../src/api/step-template-client.js';

const pagination = {
  current_page: 1,
  per_page: 25,
  total_count: 1,
  total_pages: 1,
  has_next_page: false,
  has_prev_page: false,
};

const result = {
  stepTemplates: [
    {
      id: 7,
      name: 'commit',
      step_type: 'prompt_step',
      status: 'published',
      user_turn_pattern: '^/commit',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      sessions_count: 3,
      occurrences_count: 5,
      last_seen_at: null,
    },
  ],
  pagination,
};

describe('list-step-templates command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTemplateClient as jest.Mock).mockResolvedValue({ listStepTemplates: mockListStepTemplates });
    mockListStepTemplates.mockResolvedValue(result);
  });

  test('calls listStepTemplates with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockListStepTemplates).toHaveBeenCalledWith({});
  });

  test('maps flags to camelCase SDK params, --per-page to `per`', async () => {
    await run({ search: 'comm', stepType: 'prompt_step', includeMetrics: true, page: 2, perPage: 10 });
    expect(mockListStepTemplates).toHaveBeenCalledWith({
      search: 'comm',
      stepType: 'prompt_step',
      includeMetrics: true,
      page: 2,
      per: 10,
    });
  });

  test('forwards --client-id to getTemplateClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a pagination hint and the rows in text mode', async () => {
    mockListStepTemplates.mockResolvedValue({
      ...result,
      pagination: { ...pagination, current_page: 2, total_count: 60, total_pages: 3 },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Page 2 of 3 (60 total)');
    expect(output).toContain('"name": "commit"');
    spy.mockRestore();
  });

  test('says so when --include-metrics made the server shrink the page size', async () => {
    mockListStepTemplates.mockResolvedValue({ ...result, pagination: { ...pagination, per_page: 25 } });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ includeMetrics: true, perPage: 100 });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('caps the page size at 25; 100 was requested');
    spy.mockRestore();
  });

  test('does not mention a cap when the requested page size was applied', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ includeMetrics: true, perPage: 25 });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).not.toContain('caps the page size');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getTemplateClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    expect(await run({})).not.toBe(0);
  });

  test('maps a failed SDK call through mapStepTemplateHttpError with a narrowing hint', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mapStepTemplateHttpError as jest.Mock).mockReturnValue(new CliError('STEP_TEMPLATE_ERROR', 'timed out'));
    mockListStepTemplates.mockRejectedValue(new Error('gateway timeout'));
    const code = await run({});
    expect(code).not.toBe(0);
    expect(mapStepTemplateHttpError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.any(String),
      expect.stringContaining('--search')
    );
  });

  test('reports a mapped error as a JSON envelope with --json', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mapStepTemplateHttpError as jest.Mock).mockReturnValue(new CliError('STEP_TEMPLATE_ERROR', 'boom'));
    mockListStepTemplates.mockRejectedValue(new Error('x'));
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: false, error: 'STEP_TEMPLATE_ERROR', message: 'boom' });
    spy.mockRestore();
  });
});

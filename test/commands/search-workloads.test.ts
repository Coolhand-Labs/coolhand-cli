// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockSearchWorkloads = jest.fn();

jest.mock('../../src/api/workload-client.js', () => ({
  getWorkloadClient: jest.fn().mockResolvedValue({ searchWorkloads: mockSearchWorkloads }),
  mapWorkloadHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-workloads.js';
import { getWorkloadClient, mapWorkloadHttpError } from '../../src/api/workload-client.js';

const pagination = {
  current_page: 1,
  per_page: 25,
  total_count: 1,
  total_pages: 1,
  has_next_page: false,
  has_prev_page: false,
};

const workload = {
  id: 'j35494sql6yd',
  name: 'Agent Engineering',
  description: null,
  archived: false,
  system: false,
  merged: false,
  template_count: 2,
  draft_template_count: 1,
  log_count: 160,
  last_activity: '2026-08-25T20:03:47Z',
};

const metrics = {
  days_back: null,
  since: '2026-09-01T00:00:00Z',
  until: '2026-10-01T00:00:00Z',
  request_count: 412,
  failure_count: 3,
  total_cost: 5.0213,
  priced_request_count: 408,
  total_input_tokens: 812000,
  total_output_tokens: 190000,
};

const result = { workloads: [workload], pagination };

async function captureInfo(fn: () => Promise<unknown>): Promise<string> {
  const { logger } = await import('../../src/logger.js');
  const spy = jest.spyOn(logger, 'info');
  await fn();
  const output = spy.mock.calls.map(([msg]) => msg).join('\n');
  spy.mockRestore();
  return output;
}

describe('search-workloads command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getWorkloadClient as jest.Mock).mockResolvedValue({ searchWorkloads: mockSearchWorkloads });
    mockSearchWorkloads.mockResolvedValue(result);
  });

  test('calls searchWorkloads with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockSearchWorkloads).toHaveBeenCalledWith({});
  });

  test('maps every flag to its SDK param, sending --per-page as `per`', async () => {
    await run({
      search: 'agent',
      includeArchived: true,
      includeSystem: true,
      includeTemplates: true,
      includeMetrics: true,
      daysBack: 7,
      since: '2026-09-01T00:00:00+02:00',
      until: 'not-a-date',
      page: 2,
      perPage: 50,
    });
    expect(mockSearchWorkloads).toHaveBeenCalledWith({
      search: 'agent',
      includeArchived: true,
      includeSystem: true,
      includeTemplates: true,
      includeMetrics: true,
      daysBack: 7,
      since: '2026-09-01T00:00:00+02:00',
      until: 'not-a-date',
      page: 2,
      per: 50,
    });
  });

  test('forwards --client-id to getWorkloadClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getWorkloadClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints one line per workload with hashid, name and counts', async () => {
    const output = await captureInfo(() => run({}));
    expect(output).toContain('Page 1 of 1 (1 total)');
    expect(output).toContain('j35494sql6yd  Agent Engineering  (2 templates, 160 logs)');
    expect(output).not.toContain('Requests:');
  });

  test('prints the metrics summary under each workload with --include-metrics', async () => {
    mockSearchWorkloads.mockResolvedValue({ workloads: [{ ...workload, metrics }], pagination });
    const output = await captureInfo(() => run({ includeMetrics: true }));
    expect(output).toContain('Window: 2026-09-01T00:00:00Z → 2026-10-01T00:00:00Z');
    expect(output).toContain('Requests: 412 (3 failed)');
    expect(output).toContain('Total cost: $5.0213 (408 priced requests)');
    expect(output).toContain('Tokens: 812000 in / 190000 out');
  });

  test('prints n/a when the total cost is null', async () => {
    mockSearchWorkloads.mockResolvedValue({
      workloads: [{ ...workload, metrics: { ...metrics, total_cost: null, priced_request_count: 0 } }],
      pagination,
    });
    const output = await captureInfo(() => run({ includeMetrics: true }));
    expect(output).toContain('Total cost: n/a (0 priced requests)');
  });

  test('mentions the rolling window when days_back is set', async () => {
    mockSearchWorkloads.mockResolvedValue({
      workloads: [{ ...workload, metrics: { ...metrics, days_back: 28 } }],
      pagination,
    });
    const output = await captureInfo(() => run({ includeMetrics: true }));
    expect(output).toContain('Window: last 28 days, ');
  });

  test('lists each workload\'s templates with --include-templates', async () => {
    mockSearchWorkloads.mockResolvedValue({
      workloads: [
        {
          ...workload,
          templates: [
            { id: 'tmpl-1', name: 'Summarizer', status: 'published', user_prompt_pattern: null, system_prompt_pattern: null },
          ],
        },
      ],
      pagination,
    });
    const output = await captureInfo(() => run({ includeTemplates: true }));
    expect(output).toContain('template tmpl-1  Summarizer (published)');
  });

  test('--json passes the SDK result through unchanged in the usual envelope', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result });
    spy.mockRestore();
  });

  test('maps an SDK failure through mapWorkloadHttpError and returns non-zero', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mapWorkloadHttpError as jest.Mock).mockReturnValue(new CliError('WORKLOAD_ERROR', 'boom'));
    mockSearchWorkloads.mockRejectedValue(new Error('x'));
    const code = await run({});
    expect(code).not.toBe(0);
    expect(mapWorkloadHttpError).toHaveBeenCalled();
  });

  test('emits an error envelope with --json on failure', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mapWorkloadHttpError as jest.Mock).mockReturnValue(new CliError('WORKLOAD_ERROR', 'boom'));
    mockSearchWorkloads.mockRejectedValue(new Error('x'));
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: false, error: 'WORKLOAD_ERROR', message: 'boom' });
    spy.mockRestore();
  });
});

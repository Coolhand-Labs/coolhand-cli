// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement.
const mockSearchWorkloads = jest.fn();

jest.mock('../../src/api/workload-client.js', () => ({
  getWorkloadClient: jest.fn().mockResolvedValue({ searchWorkloads: mockSearchWorkloads }),
  mapWorkloadHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-workloads.js';
import { getWorkloadClient, mapWorkloadHttpError } from '../../src/api/workload-client.js';
import { CliError } from '../../src/errors.js';
import { logger } from '../../src/logger.js';

const pagination = {
  current_page: 1,
  per_page: 25,
  total_count: 1,
  total_pages: 1,
  has_next_page: false,
  has_prev_page: false,
};

const metrics = {
  days_back: null,
  since: '2026-09-01T00:00:00Z',
  until: '2026-10-01T00:00:00Z',
  request_count: 120,
  failure_count: 3,
  error_rate: 0.025,
  error_rate_change: null,
  avg_cost_per_request: 0.01,
  total_cost: 1.23456,
  priced_request_count: 118,
  long_context_request_count: 0,
  total_input_tokens: 1000,
  total_output_tokens: 500,
  avg_input_tokens: 8,
  avg_output_tokens: 4,
  avg_latency_ms: 300,
  correctness_score: null,
  sentiment_score: null,
  revision_score: null,
  first_request_at: null,
  last_request_at: null,
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
  last_activity: null,
};

const result = { workloads: [workload], pagination };

function infoOutput(spy: jest.SpyInstance): string {
  return spy.mock.calls.map(([msg]) => msg).join('\n');
}

describe('search-workloads command', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (getWorkloadClient as jest.Mock).mockResolvedValue({ searchWorkloads: mockSearchWorkloads });
    (mapWorkloadHttpError as jest.Mock).mockImplementation((err) => err);
    mockSearchWorkloads.mockResolvedValue(result);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test('calls searchWorkloads with empty params when no flags given', async () => {
    expect(await run({})).toBe(0);
    expect(mockSearchWorkloads).toHaveBeenCalledWith({});
  });

  test('maps every flag to its camelCase SDK param, with perPage sent as `per`', async () => {
    await run({
      search: 'agent',
      includeArchived: true,
      includeSystem: true,
      includeTemplates: true,
      includeMetrics: true,
      daysBack: 7,
      since: '2026-09-01T00:00:00+02:00',
      until: '2026-10-01',
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
      until: '2026-10-01',
      page: 2,
      per: 50,
    });
  });

  test('passes since/until through as the strings the user typed, never as Dates', async () => {
    await run({ since: 'not-a-date' });
    expect(mockSearchWorkloads).toHaveBeenCalledWith({ since: 'not-a-date' });
  });

  test('omits boolean flags when false', async () => {
    await run({ includeArchived: false, includeMetrics: false });
    expect(mockSearchWorkloads).toHaveBeenCalledWith({});
  });

  test('forwards --client-id to getWorkloadClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getWorkloadClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a pagination hint and one line per workload with its hashid and counts', async () => {
    await run({});
    const output = infoOutput(infoSpy);
    expect(output).toContain('Page 1 of 1 (1 total)');
    expect(output).toContain('j35494sql6yd  Agent Engineering  templates: 2  logs: 160');
  });

  test('prints no metrics lines without metrics on the row', async () => {
    await run({});
    expect(infoOutput(infoSpy)).not.toContain('Total cost');
  });

  test('prints the window, counts, cost to 4 decimals, priced requests and tokens with metrics', async () => {
    mockSearchWorkloads.mockResolvedValue({ workloads: [{ ...workload, metrics }], pagination });
    await run({ includeMetrics: true });
    const output = infoOutput(infoSpy);
    expect(output).toContain('Window: 2026-09-01T00:00:00Z to 2026-10-01T00:00:00Z');
    expect(output).toContain('Requests: 120  Failures: 3');
    expect(output).toContain('Total cost (USD): 1.2346  Priced requests: 118');
    expect(output).toContain('Input tokens: 1000  Output tokens: 500');
  });

  test('prints n/a for a null total cost', async () => {
    mockSearchWorkloads.mockResolvedValue({
      workloads: [{ ...workload, metrics: { ...metrics, total_cost: null, priced_request_count: 0 } }],
      pagination,
    });
    await run({ includeMetrics: true });
    expect(infoOutput(infoSpy)).toContain('Total cost (USD): n/a  Priced requests: 0');
  });

  test('emits the SDK result unchanged inside the JSON envelope', async () => {
    const jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
    mockSearchWorkloads.mockResolvedValue({ workloads: [{ ...workload, metrics }], pagination });
    await run({ json: true, includeMetrics: true });
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true, result: { workloads: [{ ...workload, metrics }], pagination } });
    jsonSpy.mockRestore();
  });

  test('returns non-zero on NO_PRIVATE_KEY', async () => {
    (getWorkloadClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    expect(await run({})).not.toBe(0);
  });

  test('maps a failed SDK call through mapWorkloadHttpError and returns non-zero', async () => {
    const mapped = new CliError('WORKLOAD_ERROR', 'Workload request failed (422): {"errors":{"since":["bad"]}}');
    (mapWorkloadHttpError as jest.Mock).mockReturnValue(mapped);
    mockSearchWorkloads.mockRejectedValue(new Error('422'));
    expect(await run({ since: 'bad', includeMetrics: true })).not.toBe(0);
    expect(mapWorkloadHttpError).toHaveBeenCalledWith(expect.any(Error));
    expect(infoOutput(infoSpy)).toContain('Workload request failed (422)');
  });

  test('reports a mapped error as a JSON envelope with --json', async () => {
    const jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
    (mapWorkloadHttpError as jest.Mock).mockReturnValue(new CliError('WORKLOAD_ERROR', 'boom'));
    mockSearchWorkloads.mockRejectedValue(new Error('x'));
    await run({ json: true });
    expect(jsonSpy).toHaveBeenCalledWith({ ok: false, error: 'WORKLOAD_ERROR', message: 'boom' });
    jsonSpy.mockRestore();
  });
});

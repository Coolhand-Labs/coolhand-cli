// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement.
const mockGetStepTemplate = jest.fn();

jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn().mockResolvedValue({ getStepTemplate: mockGetStepTemplate }),
}));
jest.mock('../../src/api/step-template-client.js', () => ({
  mapStepTemplateHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/get-step-template.js';
import { getTemplateClient } from '../../src/api/template-client.js';
import { mapStepTemplateHttpError } from '../../src/api/step-template-client.js';

const cohort = {
  runs: 4,
  avg_turns_after: 1.5,
  avg_tool_calls: 6,
  avg_requests: 8,
  token_runs: 0,
  tokens_available: false,
  median_tokens: null,
  p90_tokens: null,
  tokens_per_tool_call: null,
};

const detail = {
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
  metrics: {
    total_runs: 5,
    tool_stats: [{ name: 'Bash', pct_of_runs: 80, avg_per_run: 2.5 }],
    turn_stats: { avg: 2, median: 2, high: 4, single_turn_pct: null },
    efficiency: { interactive: null, automated: cohort, all: cohort, unavailable_runs: 1 },
    notes: ['One run has no per-turn snapshot.'],
  },
};

async function output(fn: () => Promise<unknown>): Promise<string> {
  const { logger } = await import('../../src/logger.js');
  const spy = jest.spyOn(logger, 'info');
  await fn();
  const text = spy.mock.calls.map(([msg]) => msg).join('\n');
  spy.mockRestore();
  return text;
}

describe('get-step-template command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTemplateClient as jest.Mock).mockResolvedValue({ getStepTemplate: mockGetStepTemplate });
    mockGetStepTemplate.mockResolvedValue(detail);
  });

  test('calls getStepTemplate with the integer id and no options by default', async () => {
    const code = await run({ id: 7 });
    expect(code).toBe(0);
    expect(mockGetStepTemplate).toHaveBeenCalledWith(7, {});
  });

  test('--no-metrics sends includeMetrics: false', async () => {
    await run({ id: 7, noMetrics: true });
    expect(mockGetStepTemplate).toHaveBeenCalledWith(7, { includeMetrics: false });
  });

  test('forwards --client-id to getTemplateClient', async () => {
    await run({ id: 7, clientId: 'my-client' });
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints the summary fields and the turn pattern', async () => {
    const text = await output(() => run({ id: 7 }));
    expect(text).toContain('ID: 7');
    expect(text).toContain('Name: commit');
    expect(text).toContain('Step type: prompt_step');
    expect(text).toContain('Sessions: 3');
    expect(text).toContain('User Turn Pattern');
    expect(text).toContain('^/commit');
  });

  test('prints the metrics block, tolerating null cohorts and token figures', async () => {
    const text = await output(() => run({ id: 7 }));
    expect(text).toContain('Total runs: 5');
    expect(text).toContain('Turns: avg 2, median 2, high 4');
    expect(text).toContain('Bash: 80% of runs, 2.5 per run');
    expect(text).toContain('Efficiency (automated): 4 runs, 6 tool calls, 8 requests, tokens n/a');
    expect(text).not.toContain('Efficiency (interactive)');
    expect(text).toContain('Runs without a turn snapshot: 1');
    expect(text).toContain('Note: One run has no per-turn snapshot.');
  });

  test('omits the metrics block and handles null tool_stats/turn_stats/efficiency', async () => {
    mockGetStepTemplate.mockResolvedValue({
      ...detail,
      metrics: { total_runs: 0, tool_stats: null, turn_stats: null, efficiency: null, notes: [] },
    });
    const text = await output(() => run({ id: 7 }));
    expect(text).toContain('Total runs: 0');
    expect(text).not.toContain('Tools:');
    mockGetStepTemplate.mockResolvedValue({ ...detail, metrics: undefined });
    expect(await output(() => run({ id: 7 }))).not.toContain('Metrics');
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 7, json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: detail });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getTemplateClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    expect(await run({ id: 7 })).not.toBe(0);
  });

  test('returns non-zero exit on a 404-mapped error, naming the id', async () => {
    const { CliError } = await import('../../src/errors.js');
    (mapStepTemplateHttpError as jest.Mock).mockReturnValue(new CliError('STEP_TEMPLATE_ERROR', 'not found'));
    mockGetStepTemplate.mockRejectedValue(new Error('404'));
    expect(await run({ id: 99 })).not.toBe(0);
    expect(mapStepTemplateHttpError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('"99"'),
      expect.any(String)
    );
  });
});

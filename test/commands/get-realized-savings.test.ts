// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement.
const mockGetRealizedSavings = jest.fn();

jest.mock('../../src/api/template-client.js', () => ({
  getTemplateClient: jest.fn().mockResolvedValue({ getRealizedSavings: mockGetRealizedSavings }),
}));

import { HttpError } from 'coolhand-node';
import { run } from '../../src/commands/get-realized-savings.js';
import { getTemplateClient } from '../../src/api/template-client.js';
import { mapSavingsHttpError } from '../../src/api/savings-client.js';
import { logger } from '../../src/logger.js';

const savings = {
  total: 4.5372,
  cost_at_previous_versions: 5.6912,
  percent: 79.7,
  workloads: [
    {
      id: 'xwjm0lgsdmy4',
      name: 'Help Center Article Suggester',
      savings: 2.0437,
      cost_at_previous_versions: 3.0402,
      active_requests: 182,
    },
  ],
};

const zeroSavings = { total: 0, cost_at_previous_versions: 0, percent: 0, workloads: [] };

async function captureInfo(fn: () => Promise<unknown>): Promise<string> {
  const spy = jest.spyOn(logger, 'info');
  await fn();
  const output = spy.mock.calls.map(([msg]) => msg).join('\n');
  spy.mockRestore();
  return output;
}

describe('get-realized-savings command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTemplateClient as jest.Mock).mockResolvedValue({ getRealizedSavings: mockGetRealizedSavings });
    mockGetRealizedSavings.mockResolvedValue(savings);
  });

  test('calls getRealizedSavings with no arguments and exits 0', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockGetRealizedSavings).toHaveBeenCalledWith();
  });

  test('forwards --client-id to getTemplateClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getTemplateClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints the total, baseline and one line per workload', async () => {
    const output = await captureInfo(() => run({}));
    expect(output).toContain('Realized savings: $4.5372 (79.7%)');
    expect(output).toContain('Cost at previous versions: $5.6912');
    expect(output).toContain(
      'xwjm0lgsdmy4  Help Center Article Suggester  saved $2.0437 of $3.0402  (182 active requests)'
    );
  });

  test('prints zeros, not an error, when there is nothing to compare', async () => {
    mockGetRealizedSavings.mockResolvedValue(zeroSavings);
    let code: number | undefined;
    const output = await captureInfo(async () => {
      code = await run({});
    });
    expect(code).toBe(0);
    expect(output).toContain('Realized savings: $0.0000 (0%)');
    expect(output).toContain('Cost at previous versions: $0.0000');
    expect(output).not.toContain('Error');
  });

  test('--json passes the SDK result through unchanged in the usual envelope', async () => {
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ json: true });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledWith({ ok: true, result: savings });
    spy.mockRestore();
  });

  test('--json prints zero savings as the raw object', async () => {
    mockGetRealizedSavings.mockResolvedValue(zeroSavings);
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: zeroSavings });
    spy.mockRestore();
  });

  test('a 401 reports an auth problem and exits non-zero', async () => {
    mockGetRealizedSavings.mockRejectedValue(new HttpError('Unauthorized', 401));
    const output = await captureInfo(async () => {
      expect(await run({})).not.toBe(0);
    });
    expect(output).toContain('private API key is required');
    expect(output).toContain('[SAVINGS_ERROR]');
  });

  test('a 503 is a retryable error with a non-zero exit, never zeros', async () => {
    mockGetRealizedSavings.mockRejectedValue(new HttpError('Service Unavailable', 503));
    const output = await captureInfo(async () => {
      expect(await run({})).not.toBe(0);
    });
    expect(output).toContain('could not be computed right now (retryable)');
    expect(output).not.toContain('Realized savings:');
  });

  test('--json emits an error envelope on a 503', async () => {
    mockGetRealizedSavings.mockRejectedValue(new HttpError('Service Unavailable', 503));
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith({
      ok: false,
      error: 'SAVINGS_ERROR',
      message: expect.stringContaining('could not be computed right now'),
    });
    spy.mockRestore();
  });

  test('any other HTTP status keeps the SDK message, which already carries the status', () => {
    const err = mapSavingsHttpError(new HttpError('Savings request failed (500): boom', 500));
    expect(err.code).toBe('SAVINGS_ERROR');
    expect(err.message).toBe('Savings request failed (500): boom');
  });

  test('an unexpected failure is wrapped in a SAVINGS_ERROR', () => {
    const err = mapSavingsHttpError(new Error('socket hang up'));
    expect(err.code).toBe('SAVINGS_ERROR');
    expect(err.message).toBe('Savings request failed: socket hang up');
  });
});

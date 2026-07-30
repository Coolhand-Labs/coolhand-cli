// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockGetFeedback = jest.fn();

jest.mock('../../src/api/feedback-client.js', () => ({
  getFeedbackClient: jest.fn().mockResolvedValue({ getFeedback: mockGetFeedback }),
  mapFeedbackHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/get-feedback.js';
import { getFeedbackClient } from '../../src/api/feedback-client.js';

const fullRecord = {
  id: 'fb-1',
  llm_request_log_id: 99,
  sentiment: 'like',
  creator_type: 'human',
  creator_unique_id: 'user-1',
  workload_id: 42,
  collector: 'coolhand-cli-1.0.0/wildcard',
  explanation: 'Great answer',
  original_output: 'the raw output',
  revised_output: 'the revised output',
  feedback_partials: [
    { id: 'p1', sentiment: 'dislike', focus_section: 'para 2', explanation: 'too verbose' },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('get-feedback command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFeedbackClient as jest.Mock).mockResolvedValue({ getFeedback: mockGetFeedback });
    mockGetFeedback.mockResolvedValue(fullRecord);
  });

  test('calls getFeedback with the given id', async () => {
    const code = await run({ id: 'fb-1' });
    expect(code).toBe(0);
    expect(mockGetFeedback).toHaveBeenCalledWith('fb-1');
  });

  test('prints a human-readable summary including original/revised output and partials', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'fb-1' });
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('ID: fb-1');
    expect(output).toContain('Sentiment: like');
    expect(output).toContain('the raw output');
    expect(output).toContain('the revised output');
    expect(output).toContain('too verbose');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'fb-1', json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: fullRecord });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getFeedbackClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({ id: 'fb-1' });
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw on a 404-mapped error', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapFeedbackHttpError } = await import('../../src/api/feedback-client.js');
    (mapFeedbackHttpError as jest.Mock).mockReturnValue(
      new CliError('FEEDBACK_ERROR', 'Feedback "missing" not found (or does not belong to this client).')
    );
    mockGetFeedback.mockRejectedValue(new Error('404'));
    const code = await run({ id: 'missing' });
    expect(code).not.toBe(0);
  });
});

// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockSearchFeedback = jest.fn();

jest.mock('../../src/api/feedback-client.js', () => ({
  getFeedbackClient: jest.fn().mockResolvedValue({ searchFeedback: mockSearchFeedback }),
  mapFeedbackHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-feedback.js';
import { getFeedbackClient } from '../../src/api/feedback-client.js';

const emptyResult = { feedback: [], pagination: { current_page: 1, per_page: 25, total_count: 0, total_pages: 0, has_next_page: false, has_prev_page: false } };

describe('search-feedback command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFeedbackClient as jest.Mock).mockResolvedValue({ searchFeedback: mockSearchFeedback });
    mockSearchFeedback.mockResolvedValue(emptyResult);
  });

  test('calls searchFeedback with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockSearchFeedback).toHaveBeenCalledWith({});
  });

  test('maps --sentiment to the raw Ransack integer code', async () => {
    await run({ sentiment: 'positive' });
    expect(mockSearchFeedback).toHaveBeenCalledWith({ sentiment_eq: 2 });

    await run({ sentiment: 'negative' });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ sentiment_eq: 0 });

    await run({ sentiment: 'neutral' });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ sentiment_eq: 1 });
  });

  test('maps search/creatorId/workloadId/since to Ransack predicates', async () => {
    await run({ search: 'timeout', creatorId: 'user-1', workloadId: '42', since: '2026-01-01' });
    expect(mockSearchFeedback).toHaveBeenCalledWith({
      explanation_cont: 'timeout',
      creator_unique_id_eq: 'user-1',
      workload_id_eq: '42',
      created_at_gteq: '2026-01-01',
    });
  });

  test('maps --matched and --unmatched to llm_request_log_id null checks', async () => {
    await run({ matched: true });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ llm_request_log_id_not_null: 1 });

    await run({ unmatched: true });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ llm_request_log_id_null: 1 });
  });

  test('maps sortBy/sortDir to the Ransack s param, defaulting direction to desc', async () => {
    await run({ sortBy: 'created_at' });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ s: 'created_at desc' });

    await run({ sortBy: 'updated_at', sortDir: 'asc' });
    expect(mockSearchFeedback).toHaveBeenLastCalledWith({ s: 'updated_at asc' });
  });

  test('passes page and per as numeric params', async () => {
    await run({ page: 2, perPage: 50 });
    expect(mockSearchFeedback).toHaveBeenCalledWith({ page: 2, per: 50 });
  });

  test('prints a pagination hint in text mode', async () => {
    mockSearchFeedback.mockResolvedValue({
      feedback: [{ id: 'f1' }],
      pagination: { current_page: 2, per_page: 25, total_count: 60, total_pages: 3, has_next_page: true, has_prev_page: true },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 3 (60 total)'));
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: emptyResult });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getFeedbackClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw when the SDK call fails', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapFeedbackHttpError } = await import('../../src/api/feedback-client.js');
    (mapFeedbackHttpError as jest.Mock).mockReturnValue(new CliError('FEEDBACK_ERROR', 'boom'));
    mockSearchFeedback.mockRejectedValue(new Error('network down'));
    const code = await run({});
    expect(code).not.toBe(0);
  });
});

// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockListReferencedFileSessions = jest.fn();

jest.mock('../../src/api/llm-reference-client.js', () => ({
  getLlmReferenceClient: jest.fn().mockResolvedValue({ listReferencedFileSessions: mockListReferencedFileSessions }),
  mapLlmReferenceHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/list-referenced-file-sessions.js';
import { getLlmReferenceClient } from '../../src/api/llm-reference-client.js';

const emptyPagination = { current_page: 1, per_page: 25, total_count: 0, total_pages: 0, has_next_page: false, has_prev_page: false };
const oneSessionResult = {
  sessions: [{ llm_request_log_id: 'kp9npvc8qq2q', created_at: '2026-09-10T12:00:00Z' }],
  pagination: { ...emptyPagination, total_count: 1, total_pages: 1 },
};

describe('list-referenced-file-sessions command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLlmReferenceClient as jest.Mock).mockResolvedValue({ listReferencedFileSessions: mockListReferencedFileSessions });
    mockListReferencedFileSessions.mockResolvedValue(oneSessionResult);
  });

  test('calls listReferencedFileSessions with just filePath when no other flags given', async () => {
    const code = await run({ filePath: 'config/routes.rb' });
    expect(code).toBe(0);
    expect(mockListReferencedFileSessions).toHaveBeenCalledWith({ filePath: 'config/routes.rb' });
  });

  test('passes page/perPage through as camelCase SDK params', async () => {
    await run({ filePath: 'config/routes.rb', page: 2, perPage: 50 });
    expect(mockListReferencedFileSessions).toHaveBeenCalledWith({
      filePath: 'config/routes.rb',
      page: 2,
      per: 50,
    });
  });

  test('forwards --client-id to getLlmReferenceClient', async () => {
    await run({ filePath: 'config/routes.rb', clientId: 'my-client' });
    expect(getLlmReferenceClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('an unmatched file path is a real empty result, not an error', async () => {
    mockListReferencedFileSessions.mockResolvedValue({ sessions: [], pagination: emptyPagination });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ filePath: 'no/such/file.rb', json: true });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledWith({ ok: true, result: { sessions: [], pagination: emptyPagination } });
    spy.mockRestore();
  });

  test('prints a pagination hint in text mode', async () => {
    mockListReferencedFileSessions.mockResolvedValue({
      sessions: [{ llm_request_log_id: '1', created_at: '2026-09-10T12:00:00Z' }],
      pagination: { current_page: 2, per_page: 25, total_count: 60, total_pages: 3, has_next_page: true, has_prev_page: true },
    });
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'info');
    await run({ filePath: 'config/routes.rb' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page 2 of 3 (60 total)'));
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = jest.spyOn(logger, 'json');
    await run({ filePath: 'config/routes.rb', json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: oneSessionResult });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getLlmReferenceClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({ filePath: 'config/routes.rb' });
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw when the SDK call fails', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapLlmReferenceHttpError } = await import('../../src/api/llm-reference-client.js');
    (mapLlmReferenceHttpError as jest.Mock).mockReturnValue(new CliError('LLM_REFERENCE_ERROR', 'boom'));
    mockListReferencedFileSessions.mockRejectedValue(new Error('network down'));
    const code = await run({ filePath: 'config/routes.rb' });
    expect(code).not.toBe(0);
  });
});

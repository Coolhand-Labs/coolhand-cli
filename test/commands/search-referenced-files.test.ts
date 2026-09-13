// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting
// rule) AND declared before any import statement — imports execute first regardless of source
// position, so a mock const declared after an import runs into its own TDZ.
const mockSearchReferencedFiles = jest.fn();

jest.mock('../../src/api/llm-reference-client.js', () => ({
  getLlmReferenceClient: jest.fn().mockResolvedValue({ searchReferencedFiles: mockSearchReferencedFiles }),
  mapLlmReferenceHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/search-referenced-files.js';
import { getLlmReferenceClient } from '../../src/api/llm-reference-client.js';

const emptyPagination = { current_page: 1, per_page: 25, total_count: 0, total_pages: 0, has_next_page: false, has_prev_page: false };
const oneFileResult = {
  files: [{ file_path: 'config/routes.rb', reference_count: 12, last_referenced_at: '2026-09-10T12:00:00Z' }],
  pagination: { ...emptyPagination, total_count: 1, total_pages: 1 },
};

describe('search-referenced-files command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLlmReferenceClient as jest.Mock).mockResolvedValue({ searchReferencedFiles: mockSearchReferencedFiles });
    mockSearchReferencedFiles.mockResolvedValue(oneFileResult);
  });

  test('calls searchReferencedFiles with empty params when no flags given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockSearchReferencedFiles).toHaveBeenCalledWith({});
  });

  test('passes provided filter flags through as camelCase SDK params', async () => {
    await run({
      filePathContains: 'routes',
      createdAtGteq: '2026-01-01T00:00:00Z',
      createdAtLteq: '2026-09-01T00:00:00Z',
      page: 2,
      perPage: 50,
    });
    expect(mockSearchReferencedFiles).toHaveBeenCalledWith({
      filePathContains: 'routes',
      createdAtGteq: '2026-01-01T00:00:00Z',
      createdAtLteq: '2026-09-01T00:00:00Z',
      page: 2,
      per: 50,
    });
  });

  test('forwards --client-id to getLlmReferenceClient', async () => {
    await run({ clientId: 'my-client' });
    expect(getLlmReferenceClient).toHaveBeenCalledWith({ clientId: 'my-client' });
  });

  test('prints a pagination hint in text mode', async () => {
    mockSearchReferencedFiles.mockResolvedValue({
      files: [{ file_path: 'a.rb', reference_count: 1, last_referenced_at: '2026-09-10T12:00:00Z' }],
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
    expect(spy).toHaveBeenCalledWith({ ok: true, result: oneFileResult });
    spy.mockRestore();
  });

  test('returns non-zero exit on NO_PRIVATE_KEY error', async () => {
    const { CliError } = await import('../../src/errors.js');
    (getLlmReferenceClient as jest.Mock).mockRejectedValue(
      new CliError('NO_PRIVATE_KEY', "No private key configured. Run 'coolhand login --scope private' first.")
    );
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('returns non-zero exit and does not throw when the SDK call fails (e.g. 504)', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapLlmReferenceHttpError } = await import('../../src/api/llm-reference-client.js');
    (mapLlmReferenceHttpError as jest.Mock).mockReturnValue(new CliError('LLM_REFERENCE_ERROR', 'timed out'));
    mockSearchReferencedFiles.mockRejectedValue(new Error('gateway timeout'));
    const code = await run({});
    expect(code).not.toBe(0);
  });

  test('passes a retry hint naming both of this command\'s narrowing flags', async () => {
    const { CliError } = await import('../../src/errors.js');
    const { mapLlmReferenceHttpError } = await import('../../src/api/llm-reference-client.js');
    (mapLlmReferenceHttpError as jest.Mock).mockReturnValue(new CliError('LLM_REFERENCE_ERROR', 'timed out'));
    mockSearchReferencedFiles.mockRejectedValue(new Error('gateway timeout'));
    await run({});
    const hint = (mapLlmReferenceHttpError as jest.Mock).mock.calls[0][1];
    expect(hint).toContain('--file-path-contains');
    expect(hint).toContain('--per-page');
  });
});

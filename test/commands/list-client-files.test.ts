// Variables consumed inside the jest.mock factory must be prefixed with `mock` and declared
// before any import (see get-template.test.ts).
const mockListClientFiles = jest.fn();

jest.mock('../../src/api/client-file-client.js', () => ({
  getClientFileClient: jest.fn().mockResolvedValue({ listClientFiles: mockListClientFiles }),
  mapClientFileHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/list-client-files.js';
import { getClientFileClient } from '../../src/api/client-file-client.js';
import { logger } from '../../src/logger.js';
import { CliError } from '../../src/errors.js';

const pagination = {
  current_page: 1,
  per_page: 25,
  total_count: 2,
  total_pages: 1,
  has_next_page: false,
  has_prev_page: false,
};

const result = {
  files: [
    { id: 'f1', name: 'Q3 Report', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' },
    { id: 'f2', name: 'Deck', file_type: 'slide_deck', status: 'archived', description: null, metadata: {}, created_at: 'now' },
  ],
  pagination,
};

describe('list-client-files command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientFileClient as jest.Mock).mockResolvedValue({ listClientFiles: mockListClientFiles });
    mockListClientFiles.mockResolvedValue(result);
  });

  test('sends no params when no filters are given', async () => {
    const code = await run({});
    expect(code).toBe(0);
    expect(mockListClientFiles).toHaveBeenCalledWith({});
  });

  test('maps status, file type and paging flags onto the SDK params (perPage -> per)', async () => {
    await run({ status: 'draft', fileType: 'report', page: 2, perPage: 10 });
    expect(mockListClientFiles).toHaveBeenCalledWith({ status: 'draft', fileType: 'report', page: 2, per: 10 });
  });

  test('forwards --client-id to getClientFileClient', async () => {
    await run({ clientId: 'acme' });
    expect(getClientFileClient).toHaveBeenCalledWith({ clientId: 'acme' });
  });

  test('prints the page summary and one line per file', async () => {
    const spy = jest.spyOn(logger, 'info');
    await run({});
    const output = spy.mock.calls.map(([msg]) => msg).join('\n');
    expect(output).toContain('Page 1 of 1 (2 total)');
    expect(output).toContain('f1  draft  report  Q3 Report');
    expect(output).toContain('f2  archived  slide_deck  Deck');
    spy.mockRestore();
  });

  test('says so when nothing matched', async () => {
    mockListClientFiles.mockResolvedValue({ files: [], pagination: { ...pagination, total_count: 0 } });
    const spy = jest.spyOn(logger, 'info');
    await run({ status: 'published' });
    expect(spy.mock.calls.map(([msg]) => msg).join('\n')).toContain('No client files matched.');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const spy = jest.spyOn(logger, 'json');
    await run({ json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result });
    spy.mockRestore();
  });

  test('returns non-zero and emits an error envelope when the client cannot be built', async () => {
    (getClientFileClient as jest.Mock).mockRejectedValue(new CliError('NO_PRIVATE_KEY', 'No private key configured.'));
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith({ ok: false, error: 'NO_PRIVATE_KEY', message: 'No private key configured.' });
    spy.mockRestore();
  });

  test('returns non-zero when the SDK call fails with a mapped error', async () => {
    const { mapClientFileHttpError } = await import('../../src/api/client-file-client.js');
    (mapClientFileHttpError as jest.Mock).mockReturnValue(new CliError('CLIENT_FILE_ERROR', 'refused'));
    mockListClientFiles.mockRejectedValue(new Error('403'));
    expect(await run({})).not.toBe(0);
  });
});

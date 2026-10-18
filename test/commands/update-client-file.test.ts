const mockUpdateClientFileStatus = jest.fn();

jest.mock('../../src/api/client-file-client.js', () => ({
  getClientFileClient: jest.fn().mockResolvedValue({ updateClientFileStatus: mockUpdateClientFileStatus }),
  mapClientFileHttpError: jest.fn((err) => err),
}));

import { run } from '../../src/commands/update-client-file.js';
import { getClientFileClient, mapClientFileHttpError } from '../../src/api/client-file-client.js';
import { logger } from '../../src/logger.js';
import { CliError } from '../../src/errors.js';

const updated = {
  id: 'f1',
  name: 'Q3 Report',
  file_type: 'report',
  status: 'published',
  description: null,
  metadata: {},
  created_at: 'now',
};

describe('update-client-file command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientFileClient as jest.Mock).mockResolvedValue({ updateClientFileStatus: mockUpdateClientFileStatus });
    mockUpdateClientFileStatus.mockResolvedValue(updated);
  });

  test('calls updateClientFileStatus with the id and status', async () => {
    const code = await run({ id: 'f1', status: 'published' });
    expect(code).toBe(0);
    expect(mockUpdateClientFileStatus).toHaveBeenCalledWith('f1', 'published');
  });

  test('forwards --client-id to getClientFileClient', async () => {
    await run({ id: 'f1', status: 'draft', clientId: 'acme' });
    expect(getClientFileClient).toHaveBeenCalledWith({ clientId: 'acme' });
  });

  test('prints the new status', async () => {
    const spy = jest.spyOn(logger, 'info');
    await run({ id: 'f1', status: 'published' });
    expect(spy.mock.calls.map(([msg]) => msg).join('\n')).toContain('Client file "Q3 Report" (id: f1) is now published.');
    spy.mockRestore();
  });

  test('emits a JSON envelope with --json', async () => {
    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'f1', status: 'published', json: true });
    expect(spy).toHaveBeenCalledWith({ ok: true, result: updated });
    spy.mockRestore();
  });

  test('maps an SDK failure with a not-found message naming the id', async () => {
    (mapClientFileHttpError as jest.Mock).mockReturnValue(new CliError('CLIENT_FILE_ERROR', 'Client file "f9" not found'));
    mockUpdateClientFileStatus.mockRejectedValue(new Error('404'));
    const code = await run({ id: 'f9', status: 'draft' });
    expect(code).not.toBe(0);
    expect(mapClientFileHttpError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('"f9"'));
  });

  test('treats a null response as a failure rather than a success', async () => {
    mockUpdateClientFileStatus.mockResolvedValue(null);
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ id: 'f1', status: 'draft', json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'CLIENT_FILE_ERROR' }));
    spy.mockRestore();
  });
});

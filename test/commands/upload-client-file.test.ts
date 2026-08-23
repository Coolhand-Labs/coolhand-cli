const mockUploadClientFile = jest.fn();

jest.mock('../../src/upload-client-file.js', () => ({
  uploadClientFile: mockUploadClientFile,
}));

import { run } from '../../src/commands/upload-client-file.js';
import { CliError } from '../../src/errors.js';
import { logger } from '../../src/logger.js';

describe('upload-client-file command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadClientFile.mockResolvedValue({
      status: 'uploaded',
      sizeBytes: 1024,
      response: { id: 'cf_1', name: 'report.pdf', file_type: 'document', status: 'draft', description: null, metadata: {}, created_at: 'now' },
    });
  });

  test('passes filePath/name/fileType/description and clientId/dryRun through', async () => {
    await run({ filePath: '/tmp/report.pdf', name: 'My Report', fileType: 'report', description: 'desc', clientId: 'c1', dryRun: true });
    expect(mockUploadClientFile).toHaveBeenCalledWith(
      { filePath: '/tmp/report.pdf', name: 'My Report', fileType: 'report', description: 'desc' },
      { clientId: 'c1', dryRun: true }
    );
  });

  test('returns 0 on success', async () => {
    const code = await run({ filePath: '/tmp/report.pdf' });
    expect(code).toBe(0);
  });

  test('--json emits the upload result', async () => {
    const jsonSpy = jest.spyOn(logger, 'json');
    await run({ filePath: '/tmp/report.pdf', json: true });
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, dryRun: false, result: expect.objectContaining({ id: 'cf_1' }) })
    );
  });

  test('--json on dry-run shows dryRun: true', async () => {
    mockUploadClientFile.mockResolvedValue({ status: 'dry-run', sizeBytes: 1024, response: null });
    const jsonSpy = jest.spyOn(logger, 'json');
    await run({ filePath: '/tmp/report.pdf', json: true, dryRun: true });
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ ok: true, dryRun: true }));
  });

  test('CliError is mapped to its exit code and redacted JSON output', async () => {
    mockUploadClientFile.mockRejectedValue(new CliError('NOT_CONFIGURED', 'Not logged in.'));
    const jsonSpy = jest.spyOn(logger, 'json');
    const code = await run({ filePath: '/tmp/report.pdf', json: true });
    expect(code).not.toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'NOT_CONFIGURED' }));
  });

  test('non-CliError errors propagate (not swallowed)', async () => {
    mockUploadClientFile.mockRejectedValue(new Error('boom'));
    await expect(run({ filePath: '/tmp/report.pdf' })).rejects.toThrow('boom');
  });
});

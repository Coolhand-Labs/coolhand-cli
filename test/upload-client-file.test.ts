import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError } from '../src/errors.js';

const mockUploadClientFile = jest.fn();
const mockCoolhandCtor = jest.fn();

jest.mock('coolhand-node', () => ({
  Coolhand: mockCoolhandCtor,
}));

const fakeClient = {
  client_id: 'c1',
  client_name: 'Test Client',
  private_key: 'priv_key',
  base_url: 'https://coolhandlabs.com',
  saved_at: 'now',
};

jest.mock('../src/config.js', () => {
  const actual = jest.requireActual('../src/config.js');
  return {
    ...actual,
    loadConfig: jest.fn().mockResolvedValue({ version: 1, clients: { c1: {} }, default_client_id: 'c1' }),
    resolveClientForDryRun: jest.fn(),
  };
});

import { uploadClientFile } from '../src/upload-client-file.js';
import { loadConfig, resolveClientForDryRun } from '../src/config.js';

describe('uploadClientFile (shared core)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({ version: 1, clients: { c1: {} }, default_client_id: 'c1' });
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(fakeClient);
    mockCoolhandCtor.mockImplementation(() => ({ uploadClientFile: mockUploadClientFile }));
    mockUploadClientFile.mockResolvedValue({ id: 'cf_1', name: 'report.txt', file_type: 'document', status: 'draft', description: null, metadata: {}, created_at: 'now' });

    dir = path.join(os.tmpdir(), `ucf-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'report.txt');
    await fs.writeFile(filePath, 'hello world');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('uploads the file with the expected payload shape', async () => {
    const result = await uploadClientFile({ filePath, name: 'My Report', fileType: 'report', description: 'desc' });
    expect(mockUploadClientFile).toHaveBeenCalledWith({
      name: 'My Report',
      filename: 'report.txt',
      file: Buffer.from('hello world'),
      file_type: 'report',
      description: 'desc',
    });
    expect(result).toEqual({
      status: 'uploaded',
      sizeBytes: 11,
      response: expect.objectContaining({ id: 'cf_1' }),
    });
  });

  test('defaults name to the file basename when not given', async () => {
    await uploadClientFile({ filePath });
    expect(mockUploadClientFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'report.txt' }));
  });

  test('constructs Coolhand with the client private_key and base_url', async () => {
    await uploadClientFile({ filePath });
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'priv_key', baseUrl: 'https://coolhandlabs.com' })
    );
  });

  test('includes metadata when provided', async () => {
    await uploadClientFile({ filePath, metadata: { source: 'test' } });
    expect(mockUploadClientFile).toHaveBeenCalledWith(expect.objectContaining({ metadata: { source: 'test' } }));
  });

  test('throws INVALID_ARGS when the file does not exist', async () => {
    await expect(uploadClientFile({ filePath: path.join(dir, 'missing.txt') })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('throws INVALID_ARGS when the path is a directory, not a file', async () => {
    await expect(uploadClientFile({ filePath: dir })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('throws INVALID_ARGS when the file exceeds the 20MB cap', async () => {
    const bigPath = path.join(dir, 'big.bin');
    await fs.writeFile(bigPath, Buffer.alloc(21 * 1024 * 1024));
    await expect(uploadClientFile({ filePath: bigPath })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  }, 15000);

  test('throws NOT_CONFIGURED when not logged in (non-dry-run)', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(undefined);
    await expect(uploadClientFile({ filePath })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('throws NO_PRIVATE_KEY when the resolved client has no private_key', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(uploadClientFile({ filePath })).rejects.toMatchObject({ code: 'NO_PRIVATE_KEY' });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('dry-run with no resolvable client: reports size, never constructs Coolhand', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(undefined);
    const result = await uploadClientFile({ filePath }, { dryRun: true });
    expect(result).toEqual({ status: 'dry-run', sizeBytes: 11, response: null });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('dry-run with a resolved client that has no private_key: reports size, does not throw NO_PRIVATE_KEY', async () => {
    // The default `coolhand login` flow only grants the public key — a --dry-run preview must
    // still work for an already-logged-in user who hasn't run `login --scope private` yet.
    (resolveClientForDryRun as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    const result = await uploadClientFile({ filePath }, { dryRun: true });
    expect(result).toEqual({ status: 'dry-run', sizeBytes: 11, response: null });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('dry-run with a resolvable client: passes dryRun to the SDK, reports dry-run status', async () => {
    mockUploadClientFile.mockResolvedValue(null);
    const result = await uploadClientFile({ filePath }, { dryRun: true });
    expect(mockCoolhandCtor).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(result).toEqual({ status: 'dry-run', sizeBytes: 11, response: null });
  });

  test('throws UPLOAD_ERROR when the SDK returns null outside dry-run', async () => {
    mockUploadClientFile.mockResolvedValue(null);
    await expect(uploadClientFile({ filePath })).rejects.toMatchObject({ code: 'UPLOAD_ERROR' });
  });

  test('maps a base_url rejection from the SDK constructor to INVALID_BASE_URL', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(uploadClientFile({ filePath })).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });

  test('CliError instances propagate as-is (not wrapped)', async () => {
    (resolveClientForDryRun as jest.Mock).mockRejectedValue(new CliError('CLIENT_NOT_FOUND', 'nope'));
    await expect(uploadClientFile({ filePath }, { clientId: 'bad' })).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });
});

const mockDownloadClientFile = jest.fn();

jest.mock('../../src/api/client-file-client.js', () => ({
  getClientFileClient: jest.fn().mockResolvedValue({ downloadClientFile: mockDownloadClientFile }),
  mapClientFileHttpError: jest.fn((err) => err),
}));

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run, safeFilename } from '../../src/commands/download-client-file.js';
import { getClientFileClient, mapClientFileHttpError } from '../../src/api/client-file-client.js';
import { logger } from '../../src/logger.js';
import { CliError } from '../../src/errors.js';

describe('safeFilename', () => {
  test('keeps a plain filename', () => {
    expect(safeFilename('deck.txt', 'fb')).toBe('deck.txt');
  });

  test('strips POSIX and Windows directory components', () => {
    expect(safeFilename('../../etc/passwd', 'fb')).toBe('passwd');
    expect(safeFilename('..\\..\\evil.exe', 'fb')).toBe('evil.exe');
    expect(safeFilename('/abs/path/report.pdf', 'fb')).toBe('report.pdf');
  });

  test('falls back for null, empty and dot-segment names', () => {
    expect(safeFilename(null, 'fb')).toBe('fb');
    expect(safeFilename('', 'fb')).toBe('fb');
    expect(safeFilename('..', 'fb')).toBe('fb');
    expect(safeFilename('.', 'fb')).toBe('fb');
    expect(safeFilename('a/', 'fb')).toBe('fb');
  });

  test('replaces control characters', () => {
    expect(safeFilename('a\u0000b\nc.txt', 'fb')).toBe('a_b_c.txt');
  });
});

describe('download-client-file command', () => {
  let dir: string;
  let cwd: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolhand-cli-dl-'));
    cwd = process.cwd();
    process.chdir(dir);
    (getClientFileClient as jest.Mock).mockResolvedValue({ downloadClientFile: mockDownloadClientFile });
    mockDownloadClientFile.mockResolvedValue({
      content: Buffer.from([0x73, 0x6c, 0x00, 0xff]),
      contentType: 'application/octet-stream',
      filename: 'deck.bin',
    });
  });

  afterEach(async () => {
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('writes the raw bytes to the server-provided filename in the cwd by default', async () => {
    const code = await run({ id: 'f1' });
    expect(code).toBe(0);
    expect(mockDownloadClientFile).toHaveBeenCalledWith('f1');
    expect(await fs.readFile(path.join(dir, 'deck.bin'))).toEqual(Buffer.from([0x73, 0x6c, 0x00, 0xff]));
  });

  test('writes to --output when given', async () => {
    const out = path.join(dir, 'custom.bin');
    expect(await run({ id: 'f1', output: out })).toBe(0);
    expect(await fs.readFile(out)).toHaveLength(4);
  });

  test('keeps the server filename when --output is an existing directory', async () => {
    const sub = path.join(dir, 'sub');
    await fs.mkdir(sub);
    expect(await run({ id: 'f1', output: sub })).toBe(0);
    expect((await fs.stat(path.join(sub, 'deck.bin'))).isFile()).toBe(true);
  });

  test('never writes outside the target directory for a hostile server filename', async () => {
    mockDownloadClientFile.mockResolvedValue({ content: Buffer.from('x'), contentType: null, filename: '../escape.txt' });
    expect(await run({ id: 'f1' })).toBe(0);
    expect((await fs.stat(path.join(dir, 'escape.txt'))).isFile()).toBe(true);
    await expect(fs.stat(path.join(dir, '..', 'escape.txt'))).rejects.toThrow();
  });

  test('falls back to a name derived from the id when the server sends no filename', async () => {
    mockDownloadClientFile.mockResolvedValue({ content: Buffer.from('x'), contentType: null, filename: null });
    expect(await run({ id: 'f1' })).toBe(0);
    expect((await fs.stat(path.join(dir, 'client-file-f1'))).isFile()).toBe(true);
  });

  test('refuses to overwrite an existing file without --force and leaves it untouched', async () => {
    await fs.writeFile(path.join(dir, 'deck.bin'), 'original');
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ id: 'f1', json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'OUTPUT_EXISTS' }));
    expect(await fs.readFile(path.join(dir, 'deck.bin'), 'utf8')).toBe('original');
    spy.mockRestore();
  });

  test('overwrites an existing file with --force', async () => {
    await fs.writeFile(path.join(dir, 'deck.bin'), 'original');
    expect(await run({ id: 'f1', force: true })).toBe(0);
    expect(await fs.readFile(path.join(dir, 'deck.bin'))).toHaveLength(4);
  });

  test('reports path and size, and a JSON envelope with --json', async () => {
    const info = jest.spyOn(logger, 'info');
    await run({ id: 'f1' });
    expect(info.mock.calls.map(([msg]) => msg).join('\n')).toMatch(/deck\.bin \(4 bytes\)/);
    info.mockRestore();

    const spy = jest.spyOn(logger, 'json');
    await run({ id: 'f1', force: true, json: true });
    expect(spy).toHaveBeenCalledWith({
      ok: true,
      result: expect.objectContaining({ id: 'f1', sizeBytes: 4, contentType: 'application/octet-stream' }),
    });
    spy.mockRestore();
  });

  test('does not write anything when the download fails', async () => {
    (mapClientFileHttpError as jest.Mock).mockReturnValue(new CliError('CLIENT_FILE_ERROR', 'not found'));
    mockDownloadClientFile.mockRejectedValue(new Error('404'));
    expect(await run({ id: 'f9' })).not.toBe(0);
    expect(mapClientFileHttpError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('"f9"'));
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('returns CLIENT_FILE_ERROR when the destination cannot be written', async () => {
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ id: 'f1', output: path.join(dir, 'missing-dir', 'x.bin'), json: true });
    expect(code).not.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'CLIENT_FILE_ERROR' }));
    spy.mockRestore();
  });
});

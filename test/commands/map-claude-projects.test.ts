import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

const mockUploadClientFile = jest.fn();

jest.mock('../../src/upload-client-file.js', () => ({
  uploadClientFile: mockUploadClientFile,
}));

import { run, findClaudeDirs } from '../../src/commands/map-claude-projects.js';
import { logger } from '../../src/logger.js';

describe('findClaudeDirs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `mcp-find-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('finds exact case-insensitive matches at various depths', async () => {
    await fs.mkdir(path.join(dir, 'claude'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Claude2'), { recursive: true }); // not an exact match
    await fs.mkdir(path.join(dir, 'a', 'b', 'CLAUDE'), { recursive: true });
    const matches = await findClaudeDirs(dir);
    expect(matches.sort()).toEqual([path.join(dir, 'a', 'b', 'CLAUDE'), path.join(dir, 'claude')].sort());
  });

  test('does not treat a nested claude folder inside a match as a second match', async () => {
    await fs.mkdir(path.join(dir, 'claude', 'sub', 'claude'), { recursive: true });
    const matches = await findClaudeDirs(dir);
    expect(matches).toEqual([path.join(dir, 'claude')]);
  });

  test('returns just [root] when root itself is named claude', async () => {
    const claudeRoot = path.join(dir, 'Claude');
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.mkdir(path.join(claudeRoot, 'nested-claude-wont-matter'), { recursive: true });
    const matches = await findClaudeDirs(claudeRoot);
    expect(matches).toEqual([claudeRoot]);
  });

  test('matches the ".claude" dotfile convention (Claude Code home dir)', async () => {
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Documents', 'Claude'), { recursive: true });
    const matches = await findClaudeDirs(dir);
    expect(matches.sort()).toEqual(
      [path.join(dir, '.claude'), path.join(dir, 'Documents', 'Claude')].sort()
    );
  });

  test('does not match a substring like "claude-code" or "my-claude-notes"', async () => {
    await fs.mkdir(path.join(dir, 'claude-code'), { recursive: true });
    await fs.mkdir(path.join(dir, 'my-claude-notes'), { recursive: true });
    expect(await findClaudeDirs(dir)).toEqual([]);
  });

  test('returns empty array when nothing matches', async () => {
    await fs.mkdir(path.join(dir, 'unrelated'), { recursive: true });
    expect(await findClaudeDirs(dir)).toEqual([]);
  });

  test('never follows symlinked directories (no crash, no false match)', async () => {
    const real = path.join(dir, 'real-claude-target');
    await fs.mkdir(path.join(real, 'claude'), { recursive: true });
    const linkDir = path.join(dir, 'linked');
    await fs.mkdir(linkDir, { recursive: true });
    await fs.symlink(real, path.join(linkDir, 'claude-link'), 'dir');
    const matches = await findClaudeDirs(dir);
    // The real target's own "claude" subfolder is a genuine match reached by normal traversal...
    expect(matches).toContain(path.join(real, 'claude'));
    // ...but the symlink itself must never be traversed into or reported.
    expect(matches.some((m) => m.includes('linked'))).toBe(false);
  });

  test('unreadable directory is skipped rather than aborting the whole scan', async () => {
    const locked = path.join(dir, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.mkdir(path.join(dir, 'claude'), { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      const matches = await findClaudeDirs(dir);
      expect(matches).toEqual([path.join(dir, 'claude')]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});

describe('map-claude-projects command', () => {
  let home: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUploadClientFile.mockResolvedValue({
      status: 'uploaded',
      sizeBytes: 100,
      response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' },
    });
    home = path.join(os.tmpdir(), `mcp-run-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  test('no matches: exits 0, never calls uploadClientFile', async () => {
    const code = await run({}, { homedir: () => home });
    expect(code).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('generates a markdown tree with metadata and uploads it, cleaning up the temp file', async () => {
    const claudeDir = path.join(home, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'settings.json'), '{"a":1}');
    await fs.mkdir(path.join(claudeDir, 'projects'), { recursive: true });

    let capturedPath = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      capturedPath = payload.filePath;
      const content = await fs.readFile(payload.filePath, 'utf8');
      expect(content).toContain('# Claude Folders Map');
      expect(content).toContain(claudeDir);
      expect(content).toContain('settings.json');
      expect(content).toContain('KB');
      expect(content).toContain('.json');
      expect(content).toContain('projects/');
      return { status: 'uploaded', sizeBytes: Buffer.byteLength(content), response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });

    const code = await run({}, { homedir: () => home });
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
    expect(mockUploadClientFile.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: 'Claude Folders Map', fileType: 'report' })
    );
    expect(mockUploadClientFile.mock.calls[0][1]).toEqual({ clientId: undefined, dryRun: undefined });
    await expect(fs.access(capturedPath)).rejects.toThrow();
  });

  test('--root overrides the search root', async () => {
    const otherRoot = path.join(home, 'elsewhere');
    await fs.mkdir(path.join(otherRoot, 'claude'), { recursive: true });
    const code = await run({ root: otherRoot }, { homedir: () => home });
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
  });

  test('--json output includes matched paths and result', async () => {
    await fs.mkdir(path.join(home, 'claude'), { recursive: true });
    const jsonSpy = jest.spyOn(logger, 'json');
    const code = await run({ json: true }, { homedir: () => home });
    expect(code).toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        matches: 1,
        matchedPaths: [path.join(home, 'claude')],
        result: expect.objectContaining({ id: 'cf_1' }),
      })
    );
  });

  test('dry-run: reports size without a real upload result', async () => {
    await fs.mkdir(path.join(home, 'claude'), { recursive: true });
    mockUploadClientFile.mockResolvedValue({ status: 'dry-run', sizeBytes: 100, response: null });
    const jsonSpy = jest.spyOn(logger, 'json');
    const code = await run({ json: true, dryRun: true }, { homedir: () => home });
    expect(code).toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ ok: true, dryRun: true }));
  });

  test('CliError from the shared upload core is surfaced with its exit code', async () => {
    const { CliError } = await import('../../src/errors.js');
    await fs.mkdir(path.join(home, 'claude'), { recursive: true });
    mockUploadClientFile.mockRejectedValue(new CliError('INVALID_ARGS', 'too big'));
    const jsonSpy = jest.spyOn(logger, 'json');
    const code = await run({ json: true }, { homedir: () => home });
    expect(code).not.toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'INVALID_ARGS' }));
  });
});

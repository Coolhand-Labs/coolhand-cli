import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
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

  test('returns [] when --root itself is named "claude" but does not exist', async () => {
    const missingRoot = path.join(dir, 'does-not-exist', 'claude');
    await expect(findClaudeDirs(missingRoot)).resolves.toEqual([]);
  });

  test('returns [] when --root itself is named "claude" but is a file, not a directory', async () => {
    const filePath = path.join(dir, 'claude');
    await fs.writeFile(filePath, 'not a directory');
    await expect(findClaudeDirs(filePath)).resolves.toEqual([]);
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

  test('a symlinked ".claude" directory (e.g. managed by a dotfile manager) still counts as a match', async () => {
    const dotfilesTarget = path.join(dir, 'dotfiles', 'claude-config');
    await fs.mkdir(dotfilesTarget, { recursive: true });
    await fs.writeFile(path.join(dotfilesTarget, 'settings.json'), '{}');
    const linkPath = path.join(dir, '.claude');
    await fs.symlink(dotfilesTarget, linkPath, 'dir');

    const matches = await findClaudeDirs(dir);
    expect(matches).toEqual([linkPath]);
  });

  test('a symlink literally named "claude" pointing at a non-directory is not a match', async () => {
    const target = path.join(dir, 'not-a-dir.txt');
    await fs.writeFile(target, 'x');
    await fs.symlink(target, path.join(dir, 'claude'), 'file');

    expect(await findClaudeDirs(dir)).toEqual([]);
  });

  test('a broken symlink named "claude" is skipped, not reported as a match or a crash', async () => {
    await fs.symlink(path.join(dir, 'does-not-exist'), path.join(dir, 'claude'), 'dir');
    await expect(findClaudeDirs(dir)).resolves.toEqual([]);
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

  test('--root pointing at a nonexistent "claude" path reports no matches, not a false-success upload', async () => {
    const jsonSpy = jest.spyOn(logger, 'json');
    const code = await run(
      { root: path.join(home, 'does-not-exist', 'claude'), json: true },
      { homedir: () => home }
    );
    expect(code).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true, matches: 0, matchedPaths: [] });
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

  test('writes the temp report file with 0o600 permissions (not world-readable)', async () => {
    await fs.mkdir(path.join(home, 'claude'), { recursive: true });
    let mode = 0;
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      const stat = await fs.stat(payload.filePath);
      mode = stat.mode & 0o777;
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    expect(mode).toBe(0o600);
  });

  test('escapes backticks in filenames so they cannot break out of the markdown code span', async () => {
    const claudeDir = path.join(home, 'claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'weird`name`.txt'), 'x');

    let content = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      content = await fs.readFile(payload.filePath, 'utf8');
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    // A single embedded backtick must not be able to close a single-backtick code span early —
    // the whole filename (backticks included) should appear intact inside a wider fence.
    expect(content).toContain('`` weird`name`.txt ``');
  });

  test('escapes a backtick in the matched path itself (the ## heading and intro line)', async () => {
    // The "claude" folder must match exactly (isClaudeDirName) — put the backtick in an
    // ancestor directory name instead, so it ends up inside the full matched path string that
    // the intro line and "## <match>" heading are built from.
    const claudeDir = path.join(home, 'weird`parent', 'claude');
    await fs.mkdir(claudeDir, { recursive: true });

    let content = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      content = await fs.readFile(payload.filePath, 'utf8');
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    expect(content).toContain(`\`\` ${claudeDir} \`\``);
  });

  test('replaces a literal newline in a matched path so it cannot split the ## heading', async () => {
    // A newline is legal in a POSIX filename (only "/" and NUL aren't) — Node's fs calls bypass
    // shell interpretation, so this is directly creatable. Same reasoning as the backtick test
    // above: put it in an ancestor directory name so the "claude" folder still matches exactly.
    const parent = path.join(home, 'weird\nparent');
    const claudeDir = path.join(parent, 'claude');
    await fs.mkdir(claudeDir, { recursive: true });

    let content = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      content = await fs.readFile(payload.filePath, 'utf8');
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    expect(content).not.toContain(claudeDir); // the raw path (with its real newline) must not appear as-is
    expect(content).toContain('␤');
    // Exactly one heading line for the one match — if the embedded newline had split it, this
    // would be 2 (or the second half would be swallowed into some other block entirely).
    expect(content.match(/^## /gm)).toHaveLength(1);
  });

  test('lists a symlinked file (with target metadata) rather than silently dropping it', async () => {
    const claudeDir = path.join(home, 'claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const target = path.join(home, 'real-target.txt');
    await fs.writeFile(target, 'hello');
    await fs.symlink(target, path.join(claudeDir, 'linked-file.txt'), 'file');

    let content = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      content = await fs.readFile(payload.filePath, 'utf8');
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    expect(content).toContain('linked-file.txt');
    expect(content).toContain('(symlink)');
  });

  test('lists a symlinked directory but does not recurse into it', async () => {
    const claudeDir = path.join(home, 'claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const targetDir = path.join(home, 'real-target-dir');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'should-not-appear.txt'), 'x');
    await fs.symlink(targetDir, path.join(claudeDir, 'linked-dir'), 'dir');

    let content = '';
    mockUploadClientFile.mockImplementation(async (payload: any) => {
      content = await fs.readFile(payload.filePath, 'utf8');
      return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
    });
    await run({}, { homedir: () => home });
    expect(content).toContain('linked-dir');
    expect(content).toContain('not followed');
    expect(content).not.toContain('should-not-appear.txt');
  });

  test('lists a special file (e.g. a Unix socket) rather than silently dropping it', async () => {
    const claudeDir = path.join(home, 'claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const socketPath = path.join(claudeDir, 'agent.sock');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, resolve);
      server.on('error', reject);
    });

    try {
      let content = '';
      mockUploadClientFile.mockImplementation(async (payload: any) => {
        content = await fs.readFile(payload.filePath, 'utf8');
        return { status: 'uploaded', sizeBytes: 1, response: { id: 'cf_1', name: 'Claude Folders Map', file_type: 'report', status: 'draft', description: null, metadata: {}, created_at: 'now' } };
      });
      await run({}, { homedir: () => home });
      expect(content).toContain('agent.sock');
      expect(content).toContain('special file');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

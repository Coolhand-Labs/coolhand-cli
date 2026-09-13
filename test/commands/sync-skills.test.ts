import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

const mockUploadClientFile = jest.fn();

jest.mock('../../src/upload-client-file.js', () => ({
  uploadClientFile: mockUploadClientFile,
}));

jest.mock('../../src/config.js', () => {
  const actual = jest.requireActual('../../src/config.js');
  return {
    ...actual,
    loadConfig: jest.fn().mockResolvedValue({ version: 1, clients: {}, default_client_id: null }),
    resolveClientForDryRun: jest.fn().mockImplementation((_cfg: unknown, clientId?: string) =>
      Promise.resolve({
        client_id: clientId ?? 'default-client',
        client_name: 'Test Client',
        private_key: 'pk',
        base_url: 'https://coolhandlabs.com',
        saved_at: 'now',
      })
    ),
  };
});

import { run } from '../../src/commands/sync-skills.js';
import { resolveClientForDryRun } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { CliError } from '../../src/errors.js';

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content);
}

describe('sync-skills command', () => {
  let configDir: string;
  let scanDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = path.join(os.tmpdir(), `sync-skills-cfg-${randomBytes(6).toString('hex')}`);
    scanDir = path.join(os.tmpdir(), `sync-skills-src-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(scanDir, { recursive: true });
    prevConfigDir = process.env.COOLHAND_CONFIG_DIR;
    process.env.COOLHAND_CONFIG_DIR = configDir;

    jest.clearAllMocks();
    (resolveClientForDryRun as jest.Mock).mockImplementation((_cfg: unknown, clientId?: string) =>
      Promise.resolve({
        client_id: clientId ?? 'default-client',
        client_name: 'Test Client',
        private_key: 'pk',
        base_url: 'https://coolhandlabs.com',
        saved_at: 'now',
      })
    );
    mockUploadClientFile.mockImplementation((payload: { filePath: string }) =>
      Promise.resolve({
        status: 'uploaded',
        sizeBytes: 10,
        response: {
          id: `cf_${path.basename(path.dirname(payload.filePath))}`,
          name: payload.filePath,
          file_type: 'document',
          status: 'draft',
          description: null,
          metadata: {},
          created_at: 'now',
        },
      })
    );
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) {
      delete process.env.COOLHAND_CONFIG_DIR;
    } else {
      process.env.COOLHAND_CONFIG_DIR = prevConfigDir;
    }
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(scanDir, { recursive: true, force: true });
  });

  test('uploads each discovered skill and returns 0', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    await writeSkill(scanDir, 'skill-b', '---\nname: skill-b\n---\nBody');

    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(2);
  });

  test('uploads with fileType document and skill-derived name/metadata', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\ndescription: Does a thing\n---\nBody');

    await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(mockUploadClientFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'skill-a',
        fileType: 'document',
        description: 'Does a thing',
        metadata: expect.objectContaining({
          source: 'sync-skills',
          skillName: 'skill-a',
          sourceKind: 'authored',
        }),
      }),
      expect.objectContaining({})
    );
  });

  test('dry-run uploads nothing and does not touch state', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');

    const code = await run({ dryRun: true }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('does not re-upload an unchanged skill on a later run', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');

    const first = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(first).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);

    mockUploadClientFile.mockClear();
    const second = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(second).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('re-uploads a skill whose content changed since last run', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nVersion 1');
    await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });

    mockUploadClientFile.mockClear();
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nVersion 2');
    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
  });

  test('--force re-uploads an unchanged skill', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });

    mockUploadClientFile.mockClear();
    const code = await run({ force: true }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
  });

  test('collapses duplicate copies of the same skill into one upload', async () => {
    const content = '---\nname: dup-skill\n---\nSame body';
    await writeSkill(path.join(scanDir, 'a'), 'dup-skill', content);
    await writeSkill(path.join(scanDir, 'b'), 'dup-skill', content);

    const code = await run(
      {},
      {
        roots: [
          { root: path.join(scanDir, 'a'), sourceKind: 'authored' },
          { root: path.join(scanDir, 'b'), sourceKind: 'installed' },
        ],
      }
    );
    expect(code).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
  });

  test('two same-named skills with different content (edited authored copy + stale installed duplicate) both upload and both stay tracked independently across runs', async () => {
    // Regression test: an edited authored copy and a not-yet-cleaned-up stale installed copy of
    // the pre-edit content share a skillName but have different contentHash — dedupeSkillFiles
    // correctly treats them as 2 separate candidates. Before the fix, recording the second
    // candidate's upload under the shared skillName key clobbered the first's state entry,
    // causing whichever one wasn't last-recorded to be re-uploaded forever on every later run.
    await writeSkill(path.join(scanDir, 'authored'), 'my-skill', '---\nname: my-skill\n---\nNew edited content');
    await writeSkill(path.join(scanDir, 'installed'), 'my-skill', '---\nname: my-skill\n---\nStale pre-edit content');

    const roots = [
      { root: path.join(scanDir, 'authored'), sourceKind: 'authored' as const },
      { root: path.join(scanDir, 'installed'), sourceKind: 'installed' as const },
    ];

    const first = await run({}, { roots });
    expect(first).toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(2);

    mockUploadClientFile.mockClear();
    const second = await run({}, { roots });
    expect(second).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('--skill filters to matching skill names', async () => {
    await writeSkill(scanDir, 'weekly-birthday-drafts', '---\nname: weekly-birthday-drafts\n---\nBody');
    await writeSkill(scanDir, 'morning-briefing', '---\nname: morning-briefing\n---\nBody');

    await run({ skills: ['birthday'] }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
    expect(mockUploadClientFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'weekly-birthday-drafts' }), expect.anything());
  });

  test('--exclude-skill skips matching skill names', async () => {
    await writeSkill(scanDir, 'weekly-birthday-drafts', '---\nname: weekly-birthday-drafts\n---\nBody');
    await writeSkill(scanDir, 'morning-briefing', '---\nname: morning-briefing\n---\nBody');

    await run({ excludeSkills: ['birthday'] }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
    expect(mockUploadClientFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'morning-briefing' }), expect.anything());
  });

  test('a per-skill INVALID_ARGS failure does not abort the batch', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    await writeSkill(scanDir, 'skill-b', '---\nname: skill-b\n---\nBody');

    mockUploadClientFile
      .mockImplementationOnce(() => Promise.reject(new CliError('INVALID_ARGS', 'too big')))
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'uploaded',
          sizeBytes: 10,
          response: { id: 'cf_2', name: 'skill-b', file_type: 'document', status: 'draft', description: null, metadata: {}, created_at: 'now' },
        })
      );

    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(1);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(2);
  });

  test('a fatal NO_PRIVATE_KEY failure aborts the run immediately', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    await writeSkill(scanDir, 'skill-b', '---\nname: skill-b\n---\nBody');

    mockUploadClientFile.mockRejectedValue(new CliError('NO_PRIVATE_KEY', 'no private key'));

    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).not.toBe(0);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
  });

  test('--json emits a summary', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    const jsonSpy = jest.spyOn(logger, 'json');

    await run({ json: true }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, uploaded: 1, unchanged: 0, failed: 0 })
    );
  });

  test('a non-CliError from a single upload is treated as a per-skill failure, not fatal to the batch', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    await writeSkill(scanDir, 'skill-b', '---\nname: skill-b\n---\nBody');

    mockUploadClientFile
      .mockImplementationOnce(() => Promise.reject(new Error('network blip')))
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'uploaded',
          sizeBytes: 10,
          response: { id: 'cf_2', name: 'skill-b', file_type: 'document', status: 'draft', description: null, metadata: {}, created_at: 'now' },
        })
      );

    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(1);
    expect(mockUploadClientFile).toHaveBeenCalledTimes(2);
  });

  test('a non-CliError from outside the upload loop (e.g. config resolution) propagates', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    (resolveClientForDryRun as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] })).rejects.toThrow('boom');
  });

  test('fails fast with NOT_CONFIGURED when unauthenticated and not dry-run, without scanning or uploading', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(undefined);

    const code = await run({}, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).not.toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  test('an unauthenticated dry-run still scans and reports (no fail-fast)', async () => {
    await writeSkill(scanDir, 'skill-a', '---\nname: skill-a\n---\nBody');
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(undefined);

    const code = await run({ dryRun: true }, { roots: [{ root: scanDir, sourceKind: 'authored' }] });
    expect(code).toBe(0);
    expect(mockUploadClientFile).not.toHaveBeenCalled();
  });

  // These tests exercise resolveRoots/defaultRoots directly (no `deps.roots` override), via the
  // `deps.homedir` injection point. Note this deliberately does NOT use $HOME env mutation: Node's
  // os.homedir() native binding does not reliably observe a HOME env var mutated mid-test under
  // Jest (verified empirically), which is exactly why `deps.homedir` exists as a plain-JS
  // injection point instead. Since `deps.homedir` only affects the `authored`/`claude-code`
  // roots — never `installed`, which always reads the real machine's actual Cowork sessions
  // directory via the un-overridable `defaultCoworkSessionsDir()` — every test here restricts
  // `--source` away from `installed` so results stay deterministic regardless of what's on the
  // machine actually running the tests.
  describe('default root resolution (--root / --source)', () => {
    let home: string;

    beforeEach(async () => {
      home = path.join(os.tmpdir(), `sync-skills-home-${randomBytes(6).toString('hex')}`);
      await fs.mkdir(home, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(home, { recursive: true, force: true });
    });

    test('scans the authored and claude-code default roots under the injected homedir', async () => {
      await writeSkill(path.join(home, 'Documents', 'Claude'), 'authored-skill', '---\nname: authored-skill\n---\nBody');
      await writeSkill(path.join(home, '.claude', 'skills'), 'cc-skill', '---\nname: cc-skill\n---\nBody');

      const code = await run({ sources: ['authored', 'claude-code'] }, { homedir: () => home });
      expect(code).toBe(0);
      expect(mockUploadClientFile).toHaveBeenCalledTimes(2);
    });

    test('--source restricts the scan to matching sourceKinds', async () => {
      await writeSkill(path.join(home, 'Documents', 'Claude'), 'authored-skill', '---\nname: authored-skill\n---\nBody');
      await writeSkill(path.join(home, '.claude', 'skills'), 'cc-skill', '---\nname: cc-skill\n---\nBody');

      await run({ sources: ['authored'] }, { homedir: () => home });
      expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
      expect(mockUploadClientFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'authored-skill' }),
        expect.anything()
      );
    });

    test('--source rejects an unknown value', async () => {
      const code = await run({ sources: ['bogus'] }, { homedir: () => home });
      expect(code).not.toBe(0);
      expect(mockUploadClientFile).not.toHaveBeenCalled();
    });

    test('--root overrides all 3 defaults (including installed) with a single custom root', async () => {
      const customRoot = path.join(os.tmpdir(), `sync-skills-custom-${randomBytes(6).toString('hex')}`);
      await writeSkill(customRoot, 'custom-skill', '---\nname: custom-skill\n---\nBody');
      // Also plant one under the injected authored root, to prove --root replaces the defaults
      // entirely rather than adding to them.
      await writeSkill(path.join(home, 'Documents', 'Claude'), 'authored-skill', '---\nname: authored-skill\n---\nBody');
      try {
        await run({ root: customRoot }, { homedir: () => home });
        expect(mockUploadClientFile).toHaveBeenCalledTimes(1);
        expect(mockUploadClientFile).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'custom-skill' }),
          expect.anything()
        );
      } finally {
        await fs.rm(customRoot, { recursive: true, force: true });
      }
    });
  });
});

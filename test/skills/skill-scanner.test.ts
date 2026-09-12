import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';
import { findSkillFiles, dedupeSkillFiles, parseSkillFrontmatter } from '../../src/skills/skill-scanner.js';

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('parseSkillFrontmatter', () => {
  test('extracts name and description from a frontmatter block', () => {
    const content = '---\nname: my-skill\ndescription: Does a thing\n---\n\nBody text';
    expect(parseSkillFrontmatter(content)).toEqual({ name: 'my-skill', description: 'Does a thing' });
  });

  test('strips quotes around values', () => {
    const content = '---\nname: "my-skill"\ndescription: \'Does a thing\'\n---\n';
    expect(parseSkillFrontmatter(content)).toEqual({ name: 'my-skill', description: 'Does a thing' });
  });

  test('returns {} when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just a heading\n\nNo frontmatter here.')).toEqual({});
  });

  test('returns partial result when only one field is present', () => {
    const content = '---\nname: solo-name\n---\n';
    expect(parseSkillFrontmatter(content)).toEqual({ name: 'solo-name' });
  });
});

describe('findSkillFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `skill-scan-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('finds SKILL.md files at various depths and hashes their content', async () => {
    const skillDir = path.join(dir, 'my-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const content = '---\nname: my-skill\ndescription: A test skill\n---\nBody';
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), content);

    const files = await findSkillFiles([{ root: dir, sourceKind: 'authored' }]);
    expect(files).toHaveLength(1);
    expect(files[0].skillName).toBe('my-skill');
    expect(files[0].description).toBe('A test skill');
    expect(files[0].contentHash).toBe(hashOf(content));
    expect(files[0].sourceKind).toBe('authored');
  });

  test('falls back to the parent directory name when frontmatter has no name field', async () => {
    const skillDir = path.join(dir, 'fallback-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'No frontmatter here.');

    const files = await findSkillFiles([{ root: dir, sourceKind: 'installed' }]);
    expect(files[0].skillName).toBe('fallback-skill');
  });

  test('ignores files that are not literally named SKILL.md', async () => {
    const skillDir = path.join(dir, 'my-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'skill.md.txt'), 'not it');
    await fs.writeFile(path.join(skillDir, 'README.md'), 'not it either');

    const files = await findSkillFiles([{ root: dir, sourceKind: 'authored' }]);
    expect(files).toHaveLength(0);
  });

  test('treats a missing root as zero matches, not an error', async () => {
    const missing = path.join(dir, 'does-not-exist');
    await expect(findSkillFiles([{ root: missing, sourceKind: 'installed' }])).resolves.toEqual([]);
  });

  test('scans multiple roots and tags each file with its sourceKind', async () => {
    const rootA = path.join(dir, 'a');
    const rootB = path.join(dir, 'b');
    await fs.mkdir(path.join(rootA, 'skill-a'), { recursive: true });
    await fs.mkdir(path.join(rootB, 'skill-b'), { recursive: true });
    await fs.writeFile(path.join(rootA, 'skill-a', 'SKILL.md'), 'a');
    await fs.writeFile(path.join(rootB, 'skill-b', 'SKILL.md'), 'b');

    const files = await findSkillFiles([
      { root: rootA, sourceKind: 'authored' },
      { root: rootB, sourceKind: 'claude-code' },
    ]);
    expect(files.sort((x, y) => x.skillName.localeCompare(y.skillName))).toEqual([
      expect.objectContaining({ skillName: 'skill-a', sourceKind: 'authored' }),
      expect.objectContaining({ skillName: 'skill-b', sourceKind: 'claude-code' }),
    ]);
  });

  test('unreadable file is skipped with a warning, not fatal to the scan', async () => {
    const skillDir = path.join(dir, 'locked-skill');
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(filePath, 'secret');
    await fs.chmod(filePath, 0o000);
    const warnings: string[] = [];
    try {
      const files = await findSkillFiles([{ root: dir, sourceKind: 'authored' }], (msg) => warnings.push(msg));
      expect(files).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('locked-skill');
    } finally {
      await fs.chmod(filePath, 0o644);
    }
  });
});

describe('dedupeSkillFiles', () => {
  test('collapses byte-identical copies into one candidate, counting duplicates', () => {
    const files = [
      { filePath: '/a/SKILL.md', sourceKind: 'installed' as const, root: '/a', mtimeMs: 1, contentHash: 'h1', skillName: 'my-skill' },
      { filePath: '/b/SKILL.md', sourceKind: 'installed' as const, root: '/b', mtimeMs: 2, contentHash: 'h1', skillName: 'my-skill' },
      { filePath: '/c/SKILL.md', sourceKind: 'installed' as const, root: '/c', mtimeMs: 3, contentHash: 'h1', skillName: 'my-skill' },
    ];
    const candidates = dedupeSkillFiles(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].duplicateCount).toBe(3);
  });

  test('prefers an authored copy over an installed copy of the same content', () => {
    const files = [
      { filePath: '/installed/SKILL.md', sourceKind: 'installed' as const, root: '/installed', mtimeMs: 100, contentHash: 'h1', skillName: 'my-skill' },
      { filePath: '/authored/SKILL.md', sourceKind: 'authored' as const, root: '/authored', mtimeMs: 1, contentHash: 'h1', skillName: 'my-skill' },
    ];
    const candidates = dedupeSkillFiles(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].filePath).toBe('/authored/SKILL.md');
    expect(candidates[0].sourceKind).toBe('authored');
  });

  test('a genuinely edited authored copy (different hash) is its own candidate, not squashed by a stale installed duplicate', () => {
    const files = [
      { filePath: '/installed/SKILL.md', sourceKind: 'installed' as const, root: '/installed', mtimeMs: 1, contentHash: 'h-old', skillName: 'my-skill' },
      { filePath: '/authored/SKILL.md', sourceKind: 'authored' as const, root: '/authored', mtimeMs: 100, contentHash: 'h-new', skillName: 'my-skill' },
    ];
    const candidates = dedupeSkillFiles(files);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.contentHash).sort()).toEqual(['h-new', 'h-old']);
  });

  test('within the same sourceKind, prefers the newer mtime', () => {
    const files = [
      { filePath: '/old/SKILL.md', sourceKind: 'installed' as const, root: '/old', mtimeMs: 1, contentHash: 'h1', skillName: 'my-skill' },
      { filePath: '/new/SKILL.md', sourceKind: 'installed' as const, root: '/new', mtimeMs: 100, contentHash: 'h1', skillName: 'my-skill' },
    ];
    const candidates = dedupeSkillFiles(files);
    expect(candidates[0].filePath).toBe('/new/SKILL.md');
  });

  test('different skill names with the same content are not merged', () => {
    const files = [
      { filePath: '/a/SKILL.md', sourceKind: 'authored' as const, root: '/a', mtimeMs: 1, contentHash: 'h1', skillName: 'skill-a' },
      { filePath: '/b/SKILL.md', sourceKind: 'authored' as const, root: '/b', mtimeMs: 1, contentHash: 'h1', skillName: 'skill-b' },
    ];
    expect(dedupeSkillFiles(files)).toHaveLength(2);
  });
});

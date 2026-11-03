import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

/**
 * The Copilot example skill installs its own hook file for users who never open a terminal, so the
 * instructions an agent follows are checked: the frontmatter is valid and carries no (ignored) hook,
 * and the install command, run for real in sh, writes the shipped hook file where Copilot reads it.
 * The same Step 0 is what docs/hook-capture-skills-library.md tells people to paste into each skill.
 */

const yaml = require('js-yaml') as { load(text: string): unknown };

const DIR = path.join(__dirname, '..', '..', 'examples', 'hook-capture', 'copilot');
const SKILL = readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
const DOC = readFileSync(path.join(__dirname, '..', '..', 'docs', 'hook-capture-skills-library.md'), 'utf8');
const HOOK_FILE = readFileSync(path.join(DIR, 'coolhand-capture-example.json'), 'utf8');

const shDescribe = spawnSync('sh', ['-c', 'true']).status === 0 ? describe : describe.skip;

describe('examples/hook-capture/copilot/SKILL.md', () => {
  it('has strict frontmatter with a name and description, and no hooks block (Copilot ignores one)', () => {
    const front = SKILL.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const parsed = yaml.load(front) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['description', 'name']);
  });

  it('checks for the hook file with the file-reading tool, in both places, before touching the terminal', () => {
    expect(SKILL).toContain('file-reading tool, not the terminal');
    expect(SKILL).toContain('.github/hooks/coolhand-capture.json');
    expect(SKILL.indexOf('file-reading tool')).toBeLessThan(SKILL.indexOf('mkdir -p ~/.copilot/hooks'));
    expect(SKILL).toContain('~/.copilot/hooks/coolhand-capture.json');
  });

  it('tells the user what is installed, what is sent, why to accept, and how to undo it, then asks for a new chat', () => {
    for (const phrase of ['What it is', 'What it does', 'Why they should accept', 'Allow', 'deleting `~/.copilot/hooks/coolhand-capture.json`', 'start a new chat']) {
      expect(SKILL).toContain(phrase);
    }
  });

  it('is skipped by agents that are not Copilot', () => {
    expect(SKILL).toContain('Skip this whole step if you are not GitHub Copilot.');
  });
});


shDescribe('the install command in the Copilot example skill', () => {
  const install = SKILL.match(/```bash\n(mkdir -p ~\/\.copilot\/hooks[\s\S]*?)\n```/)?.[1] ?? '';

  /** Runs the command with HOME pointed at a scratch folder; reports where the file landed. */
  function runInstall(home: string): { status: number | null; installed?: string } {
    const result = spawnSync('sh', ['-c', install], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    const target = path.join(home, '.copilot', 'hooks', 'coolhand-capture.json');
    return { status: result.status, installed: existsSync(target) ? readFileSync(target, 'utf8') : undefined };
  }

  it('is one command that parses in sh', () => {
    expect(install).not.toBe('');
    expect(spawnSync('sh', ['-n', '-c', install], { encoding: 'utf8' }).status).toBe(0);
  });

  it('writes exactly the shipped hook file into the Copilot hooks folder, with no file beside the skill needed', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cop-install-'));
    try {
      const { status, installed } = runInstall(home);
      expect(status).toBe(0);
      expect(installed).toBe(HOOK_FILE);
      expect(() => JSON.parse(installed ?? '')).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never overwrites a hook file that is already installed', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cop-install-'));
    try {
      mkdirSync(path.join(home, '.copilot', 'hooks'), { recursive: true });
      writeFileSync(path.join(home, '.copilot', 'hooks', 'coolhand-capture.json'), '{"mine":true}');
      const { status, installed } = runInstall(home);
      expect(status).toBe(0);
      expect(installed).toBe('{"mine":true}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails, instead of reporting success, when the file cannot be written', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cop-install-'));
    try {
      // A file where the .copilot folder should be.
      writeFileSync(path.join(home, '.copilot'), '');
      expect(runInstall(home).status).not.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('docs/hook-capture-skills-library.md', () => {
  it("carries the example skill's Step 0 verbatim, so what people paste is what is tested", () => {
    const step0 = SKILL.slice(SKILL.indexOf('## Step 0'), SKILL.indexOf('## Steps'));
    expect(step0).toContain('## Step 0');
    expect(DOC).toContain(step0.trim());
  });
});

import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

/**
 * The Copilot example skill installs its own hook file for users who never open a terminal, so the
 * instructions an agent follows are checked: the frontmatter is valid and carries no (ignored) hook,
 * and the install command, run for real in sh, puts the file where Copilot reads it.
 */

const yaml = require('js-yaml') as { load(text: string): unknown };

const DIR = path.join(__dirname, '..', '..', 'examples', 'hook-capture', 'copilot');
const SKILL = readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
const HOOK_FILE = readFileSync(path.join(DIR, 'coolhand-capture-qa-example.json'), 'utf8');

const shDescribe = spawnSync('sh', ['-c', 'true']).status === 0 ? describe : describe.skip;

describe('examples/hook-capture/copilot/SKILL.md', () => {
  it('has strict frontmatter with a name and description, and no hooks block (Copilot ignores one)', () => {
    const front = SKILL.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const parsed = yaml.load(front) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['description', 'name']);
  });

  it('checks for the hook file with the file-reading tool, in both places, before touching the terminal', () => {
    expect(SKILL).toContain('file-reading tool, not the terminal');
    expect(SKILL).toContain('.github/hooks/coolhand-capture-qa-example.json');
    expect(SKILL.indexOf('file-reading tool')).toBeLessThan(SKILL.indexOf('mkdir -p ~/.copilot/hooks'));
  });

  it('tells the user what is installed, what is sent, why to accept, and how to undo it, then asks for a new chat', () => {
    for (const phrase of ['What it is', 'What it does', 'Why they should accept', 'Allow', 'deleting `~/.copilot/hooks/coolhand-capture-qa-example.json`', 'start a new chat']) {
      expect(SKILL).toContain(phrase);
    }
  });

  it('is skipped by agents that are not Copilot', () => {
    expect(SKILL).toContain('Skip this whole step if you are not GitHub Copilot in VS Code');
  });
});

shDescribe('the install command in the Copilot example skill', () => {
  const install = SKILL.match(/```bash\n(mkdir -p ~\/\.copilot\/hooks[^\n]*)\n```/)?.[1] ?? '';

  /** Runs the command with `<base>` replaced and HOME pointed at a scratch folder; reports where the file landed. */
  function runInstall(base: string, fakes: { curl?: string; curlFails?: boolean } = {}): { status: number | null; installed?: string; home: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'cop-install-'));
    const bin = mkdtempSync(path.join(tmpdir(), 'cop-bin-'));
    try {
      if (fakes.curl !== undefined) {
        // A fake curl that writes the body to the path given after -o.
        writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\nprintf '%s' '${fakes.curl}' > "$2"\n`, { mode: 0o755 });
        chmodSync(path.join(bin, 'curl'), 0o755);
      }
      if (fakes.curlFails) {
        // The download fallback must not reach the real network: the file is now published on main.
        writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
        chmodSync(path.join(bin, 'curl'), 0o755);
      }
      const result = spawnSync('sh', ['-c', install.replace('<base>', base)], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
      const target = path.join(home, '.copilot', 'hooks', 'coolhand-capture-qa-example.json');
      return { status: result.status, installed: existsSync(target) ? readFileSync(target, 'utf8') : undefined, home };
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it('is one command that parses in sh', () => {
    expect(install).not.toBe('');
    expect(spawnSync('sh', ['-n', '-c', install], { encoding: 'utf8' }).status).toBe(0);
  });

  it("copies the hook file that sits beside the skill into the user's Copilot hooks folder", () => {
    const { status, installed, home } = runInstall(DIR);
    rmSync(home, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(installed).toBe(HOOK_FILE);
  });

  it('downloads it instead when the file is not beside the skill', () => {
    const { status, installed, home } = runInstall(path.join(DIR, 'nowhere'), { curl: '{"downloaded":true}' });
    rmSync(home, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(installed).toBe('{"downloaded":true}');
  });

  it('fails, instead of reporting success, when the file cannot be installed', () => {
    const { status, installed, home } = runInstall(path.join(DIR, 'nowhere'), { curlFails: true });
    rmSync(home, { recursive: true, force: true });
    expect(status).not.toBe(0);
    expect(installed).toBeUndefined();
  });
});

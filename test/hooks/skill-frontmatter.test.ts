import { spawnSync } from 'child_process';
import * as os from 'os';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';

/**
 * Claude Code drops a skill's `hooks` SILENTLY when the frontmatter is not valid YAML (it still loads
 * the skill from a lenient fallback parse). So every SKILL.md that carries the capture hook must parse
 * strictly, and its command must be valid shell. js-yaml is pinned by this package's `overrides`.
 */
const yaml = require('js-yaml') as { load(text: string): unknown };

const ROOT = path.join(__dirname, '..', '..');
/** Every SKILL.md in the repo that declares hooks, so a new skill is covered without editing this test. */
function skillsWithTheHook(): string[] {
  const found: string[] = [];
  for (const base of ['.claude/skills', 'examples/hook-capture']) {
    const dir = path.join(ROOT, base);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(base, entry.name, 'SKILL.md');
      if (entry.isDirectory() && existsSync(path.join(ROOT, file)) && /^hooks:/m.test(readFileSync(path.join(ROOT, file), 'utf8'))) {
        found.push(file);
      }
    }
  }
  return found;
}
const SKILLS = skillsWithTheHook();

function frontmatter(file: string): unknown {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) {
    throw new Error(`${file} has no frontmatter`);
  }
  return yaml.load(match[1]);
}

// These tests run the hook commands through a real POSIX shell; skip them where there isn't one (Windows).
const HAS_SH = spawnSync('sh', ['-c', 'true']).status === 0;
const shDescribe = HAS_SH ? describe : describe.skip;

shDescribe('skills that carry the capture hook', () => {
  it('finds the skills it is supposed to check', () => {
    expect(SKILLS).toEqual(expect.arrayContaining(['examples/hook-capture/claude/SKILL.md', '.claude/skills/loop-review/SKILL.md']));
  });

  it.each(SKILLS)('%s has strictly valid frontmatter with a parseable Stop hook', (file) => {
    const meta = frontmatter(file) as { hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; command?: string; async?: boolean; timeout?: number }> }> } };
    const hook = meta.hooks?.Stop?.[0]?.hooks?.[0];

    expect(hook?.type).toBe('command');
    // An async hook is killed when Claude Code exits, so the last turn of a headless run is lost.
    expect(hook?.async).not.toBe(true);
    expect(typeof hook?.timeout).toBe('number');
    expect(hook?.command).toContain('capture-turn');
    const syntax = spawnSync('sh', ['-n', '-c', hook?.command ?? ''], { encoding: 'utf8' });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('the strict parse really does reject the frontmatter mistake that silently drops hooks', () => {
    expect(() => yaml.load('argument-hint: [low|medium] [--max-rounds N]')).toThrow();
  });

  describe('the loop-review hook is opt-in through its own variable', () => {
    const command = (() => {
      const meta = frontmatter('.claude/skills/loop-review/SKILL.md') as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
      return meta.hooks.Stop[0].hooks[0].command;
    })();

    function run(extraEnv: Record<string, string>): { ran: string } {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-hook-'));
      const marker = path.join(dir, 'marker');
      const fake = path.join(dir, 'coolhand');
      writeFileSync(fake, `#!/bin/sh\necho "ran key=$COOLHAND_API_KEY" >> "${marker}"\ncat >/dev/null\n`);
      chmodSync(fake, 0o755);
      try {
        spawnSync('sh', ['-c', command], {
          input: '{}',
          env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...extraEnv },
          encoding: 'utf8',
        });
        let ran = '';
        try {
          ran = readFileSync(marker, 'utf8');
        } catch {
          // never ran
        }
        return { ran };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('starts nothing without COOLHAND_CAPTURE_API_KEY', () => {
      expect(run({}).ran).toBe('');
    });

    it('is not switched on by the COOLHAND_API_KEY that `coolhand claude` injects into its child', () => {
      expect(run({ COOLHAND_API_KEY: 'proxy-injected-key' }).ran).toBe('');
    });

    it('runs capture-turn with the opt-in key when it is set', () => {
      expect(run({ COOLHAND_CAPTURE_API_KEY: 'opt-in-key' }).ran).toContain('ran key=opt-in-key');
    });
  });
});

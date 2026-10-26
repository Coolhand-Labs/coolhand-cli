import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
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

describe('skills that carry the capture hook', () => {
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
});

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

/**
 * Claude Code drops a skill's `hooks` SILENTLY when the frontmatter is not valid YAML (it still loads
 * the skill from a lenient fallback parse). So every SKILL.md that carries the capture hook must parse
 * strictly, and its command must be valid shell. js-yaml is pinned by this package's `overrides`.
 */
const yaml = require('js-yaml') as { load(text: string): unknown };

const ROOT = path.join(__dirname, '..', '..');
const SKILLS = [
  'examples/hook-capture/claude/SKILL.md',
  '.claude/skills/loop-review/SKILL.md',
];

function frontmatter(file: string): unknown {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    throw new Error(`${file} has no frontmatter`);
  }
  return yaml.load(match[1]);
}

describe('skills that carry the capture hook', () => {
  it.each(SKILLS)('%s has strictly valid frontmatter with a parseable Stop hook', (file) => {
    const meta = frontmatter(file) as { hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> } };
    const hook = meta.hooks?.Stop?.[0]?.hooks?.[0];

    expect(hook?.type).toBe('command');
    expect(hook?.command).toContain('capture-turn');
    const syntax = spawnSync('sh', ['-n', '-c', hook?.command ?? ''], { encoding: 'utf8' });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('the strict parse really does reject the frontmatter mistake that silently drops hooks', () => {
    expect(() => yaml.load('argument-hint: [low|medium] [--max-rounds N]')).toThrow();
  });
});

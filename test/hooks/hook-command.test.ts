import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';

/**
 * The example hook commands are what people paste into their skills, so they must at least parse in
 * a real shell. The capture-turn tests call run() directly and never see this string.
 */

const EXAMPLES = path.join(__dirname, '..', '..', 'examples', 'hook-capture');
const DOC = path.join(__dirname, '..', '..', 'docs', 'hook-capture.md');

function commandsIn(file: string, keys: string[]): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const key of keys) {
    const pattern = new RegExp(`${key}"?:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
    for (const match of text.matchAll(pattern)) {
      found.push(JSON.parse(`"${match[1]}"`) as string);
    }
  }
  return found;
}

describe('documented hook commands', () => {
  const cases: Array<[string, string[]]> = [
    ['claude/SKILL.md', commandsIn(path.join(EXAMPLES, 'claude', 'SKILL.md'), ['command'])],
    ['cursor/hooks.json', commandsIn(path.join(EXAMPLES, 'cursor', 'hooks.json'), ['command'])],
    ['copilot/coolhand-capture.json', commandsIn(path.join(EXAMPLES, 'copilot', 'coolhand-capture.json'), ['bash'])],
    ['docs/hook-capture.md', commandsIn(DOC, ['command'])],
  ];

  it.each(cases)('%s has commands and each one parses in sh', (_name, commands) => {
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const result = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf8' });
      expect({ command, status: result.status, stderr: result.stderr }).toEqual({ command, status: 0, stderr: '' });
      expect(command).toContain('capture-turn');
    }
  });
});

import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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

// Runs the commands through a real POSIX shell; skipped where there isn't one (Windows).
const shDescribe = spawnSync('sh', ['-c', 'true']).status === 0 ? describe : describe.skip;

shDescribe('documented hook commands', () => {
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

shDescribe('the hook command picks a CLI that knows capture-turn', () => {
  const claudeCommand = commandsIn(path.join(EXAMPLES, 'claude', 'SKILL.md'), ['command'])[0];
  const skillCommand = commandsIn(path.join(__dirname, '..', '..', '.claude', 'skills', 'loop-review', 'SKILL.md'), ['command'])[0];

  /** Runs `command` with fake `coolhand` and `npx` binaries first on PATH; reports which one got the hook JSON. */
  function runHook(command: string, fakes: { coolhand?: 'old' | 'new' }): { coolhand?: string; npx?: string; status: number | null } {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-cmd-'));
    try {
      const fake = (name: string, helpExit: number) =>
        writeFileSync(path.join(dir, name), `#!/bin/sh\n[ "$1" = help ] && exit ${helpExit}\ncat > "${dir}/${name}.stdin"\n`, { mode: 0o755 });
      if (fakes.coolhand) {
        fake('coolhand', fakes.coolhand === 'new' ? 0 : 1);
      }
      fake('npx', 0);
      chmodSync(path.join(dir, 'npx'), 0o755);
      const result = spawnSync('sh', ['-c', command], { input: '{"hook":1}', env: { PATH: `${dir}:/usr/bin:/bin`, COOLHAND_CAPTURE_API_KEY: 'ch_pub_testkey123456' }, encoding: 'utf8' });
      const read = (name: string) => (existsSync(path.join(dir, `${name}.stdin`)) ? readFileSync(path.join(dir, `${name}.stdin`), 'utf8') : undefined);
      return { coolhand: read('coolhand'), npx: read('npx'), status: result.status };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([['claude example', claudeCommand], ['loop-review skill', skillCommand]])('%s: uses an installed CLI that knows capture-turn', (_name, command) => {
    expect(runHook(command, { coolhand: 'new' })).toEqual({ coolhand: '{"hook":1}', npx: undefined, status: 0 });
  });

  it.each([['claude example', claudeCommand], ['loop-review skill', skillCommand]])('%s: bypasses an older installed CLI with npx and still passes it the hook JSON', (_name, command) => {
    expect(runHook(command, { coolhand: 'old' })).toEqual({ coolhand: undefined, npx: '{"hook":1}', status: 0 });
  });

  it.each([['claude example', claudeCommand], ['loop-review skill', skillCommand]])('%s: uses npx when no CLI is installed', (_name, command) => {
    expect(runHook(command, {})).toEqual({ coolhand: undefined, npx: '{"hook":1}', status: 0 });
  });
});

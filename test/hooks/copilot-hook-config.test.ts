import { readFileSync } from 'fs';
import * as path from 'path';

/**
 * VS Code drops a hook file it cannot parse without saying so, so the shipped one is checked strictly:
 * what the spike showed Copilot accepts, and nothing that makes a hook run twice.
 */

const DIR = path.join(__dirname, '..', '..', 'examples', 'hook-capture', 'copilot');

describe.each(['coolhand-capture.json', path.join('workspace', 'coolhand-capture.json')])('examples/hook-capture/copilot/%s', (name) => {
  const FILE = path.join(DIR, name);
  const config = JSON.parse(readFileSync(FILE, 'utf8')) as { version: unknown; hooks: Record<string, Array<Record<string, unknown>>> };

  it('is a version 1 hook file', () => {
    expect(config.version).toBe(1);
    expect(Object.keys(config).sort()).toEqual(['hooks', 'version']);
  });

  it('registers only the PascalCase Stop event: Copilot honours both spellings, and both would run the hook twice', () => {
    expect(Object.keys(config.hooks)).toEqual(['Stop']);
  });

  it('runs a synchronous command with a numeric timeout that outlasts a send', () => {
    const [hook, ...rest] = config.hooks.Stop;
    expect(rest).toEqual([]);
    expect(Object.keys(hook).sort()).toEqual(['bash', 'timeoutSec', 'type']);
    expect(hook.type).toBe('command');
    expect(hook.timeoutSec).toBeGreaterThanOrEqual(10);
    expect(typeof hook.bash).toBe('string');
    expect(hook.bash).toContain('capture-turn --agent copilot --skill qa-example');
    expect(hook.bash).toContain('coolhand help capture-turn');
    expect(hook.bash).toContain('npx -y coolhand-cli');
  });

  it('carries a placeholder, never a real key', () => {
    expect(readFileSync(FILE, 'utf8')).not.toMatch(/ch_(pub|priv)_|sk-/);
  });
});

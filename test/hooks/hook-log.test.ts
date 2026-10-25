import { promises as fs } from 'fs';
import * as path from 'path';
import { logHookEvent } from '../../src/hooks/hook-log.js';
import { loadTurnState, saveTurnState, turnsDir } from '../../src/hooks/turn-state.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

describe('hook housekeeping', () => {
  let home: TmpHome;
  beforeEach(async () => {
    home = await createTmpHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('cuts hook.log back to its recent tail instead of discarding it', async () => {
    const file = path.join(turnsDir(), 'hook.log');
    await fs.mkdir(turnsDir(), { recursive: true });
    await fs.writeFile(file, `${'old line\n'.repeat(40000)}`);
    await logHookEvent('newest failure');

    const text = await fs.readFile(file, 'utf8');
    expect(text.length).toBeLessThan(80 * 1024);
    expect(text.trimEnd().endsWith('newest failure')).toBe(true);
    expect(text.startsWith('old line\n')).toBe(true); // no partial first line
  });

  it('clears per-session state files untouched for 30 days when a new session starts', async () => {
    await saveTurnState('claude', 'stale', { turnIndex: 5 });
    const stale = (await fs.readdir(turnsDir())).find((n) => n.startsWith('claude-stale'))!;
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(turnsDir(), stale), old, old);

    await saveTurnState('claude', 'fresh', { turnIndex: 1 });

    expect((await fs.readdir(turnsDir())).some((n) => n.startsWith('claude-stale'))).toBe(false);
    expect((await loadTurnState('claude', 'fresh')).turnIndex).toBe(1);
  });

  it('round-trips the cached tester', async () => {
    await saveTurnState('claude', 's', { turnIndex: 2, tester: { id: 'a@b.c', source: 'git' } });
    expect((await loadTurnState('claude', 's')).tester).toEqual({ id: 'a@b.c', source: 'git' });
  });
});

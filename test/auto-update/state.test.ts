import { promises as fs } from 'fs';
import { acquireLock, loadState, saveState, statePath } from '../../src/auto-update/state.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

describe('update state', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  describe('loadState', () => {
    test('returns an empty state for a missing or corrupt file', async () => {
      expect(await loadState()).toEqual({});
      await fs.writeFile(statePath(), '{not json');
      expect(await loadState()).toEqual({});
      await fs.writeFile(statePath(), 'null');
      expect(await loadState()).toEqual({});
    });

    test('keeps well-formed fields', async () => {
      const state = {
        last_check: '2026-11-01T00:00:00.000Z',
        available: '1.2.3',
        notified: '1.2.3',
        installed: '1.2.2',
        failed: { version: '1.2.4', at: '2026-11-01T00:00:00.000Z' },
      };
      await saveState(state);
      expect(await loadState()).toEqual(state);
    });

    test('drops wrongly typed fields and versions that are not plain stable semver', async () => {
      await fs.writeFile(
        statePath(),
        JSON.stringify({
          last_check: 5,
          notified: { x: 1 },
          available: '1.2.3-beta.1',
          installed: '1.2',
          failed: { version: '1.2.3' },
        })
      );
      expect(await loadState()).toEqual({});
    });
  });

  describe('acquireLock', () => {
    test('exactly one of several simultaneous callers gets the lock', async () => {
      const results = await Promise.all([acquireLock(), acquireLock(), acquireLock(), acquireLock()]);
      const held = results.filter((r) => r !== null);
      expect(held).toHaveLength(1);
      await held[0]!();
      // Released: the next caller can take it.
      const again = await acquireLock();
      expect(again).not.toBeNull();
      await again!();
    });

    test('returns null instead of throwing when the lock cannot be created', async () => {
      // A file where the config directory should be makes mkdir fail.
      const blocker = `${home.dir}/blocker`;
      await fs.writeFile(blocker, '');
      process.env.COOLHAND_CONFIG_DIR = `${blocker}/sub`;
      await expect(acquireLock()).resolves.toBeNull();
      process.env.COOLHAND_CONFIG_DIR = home.dir;
    });
  });
});

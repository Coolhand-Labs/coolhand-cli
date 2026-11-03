import { acquireLock } from '../../src/auto-update/state.js';
import { run as runUpdate } from '../../src/commands/update.js';
import { CliError } from '../../src/errors.js';
import { logger } from '../../src/logger.js';
import { PACKAGE_VERSION } from '../../src/version.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

describe('update command', () => {
  let fetchSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let jsonSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    infoSpy.mockRestore();
    jsonSpy.mockRestore();
  });

  const registry = (ageHours: number) =>
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '99.0.0' },
        time: { '99.0.0': new Date(Date.now() - ageHours * 3600 * 1000).toISOString() },
        versions: { '99.0.0': {} },
      }),
    } as Response);

  test('--check reports a baked release without installing', async () => {
    fetchSpy = registry(72);
    expect(await runUpdate({ check: true, json: true })).toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith({ current: PACKAGE_VERSION, target: '99.0.0', installed: false });
  });

  test('reports up to date when the newest release is still baking', async () => {
    fetchSpy = registry(2);
    expect(await runUpdate({ json: true })).toBe(0);
    expect(jsonSpy).toHaveBeenCalledWith({ current: PACKAGE_VERSION, target: null, installed: false });
  });

  test('prints the manual command when this is not a global npm install', async () => {
    fetchSpy = registry(72);
    expect(await runUpdate({})).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('npm install -g coolhand-cli@99.0.0'));
  });

  test('a registry failure is a CliError', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(runUpdate({ check: true })).rejects.toBeInstanceOf(CliError);
  });

  test('an invalid COOLHAND_UPDATE_REGISTRY is an UPDATE_ERROR, not a fallback to npmjs', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    process.env.COOLHAND_UPDATE_REGISTRY = 'https://user:pw@mirror.example.com';
    try {
      await expect(runUpdate({ check: true })).rejects.toMatchObject({ code: 'UPDATE_ERROR' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.COOLHAND_UPDATE_REGISTRY;
    }
  });

  describe('installing', () => {
    test('installs, verifies the files on disk, and reports installed: true', async () => {
      fetchSpy = registry(72);
      const install = jest.fn().mockResolvedValue(true);
      expect(await runUpdate({ json: true }, { selfInstall: true, install, versionOnDisk: () => '99.0.0' })).toBe(0);
      // --json keeps npm's stdout out of the payload.
      expect(install).toHaveBeenCalledWith('99.0.0', ['ignore', 'ignore', 'inherit']);
      expect(jsonSpy).toHaveBeenCalledWith({ current: PACKAGE_VERSION, target: '99.0.0', installed: true });
    });

    test('plain output lets npm print to the terminal', async () => {
      fetchSpy = registry(72);
      const install = jest.fn().mockResolvedValue(true);
      await runUpdate({}, { selfInstall: true, install, versionOnDisk: () => '99.0.0' });
      expect(install).toHaveBeenCalledWith('99.0.0', 'inherit');
    });

    test('a failed npm install is an UPDATE_ERROR', async () => {
      fetchSpy = registry(72);
      const install = jest.fn().mockResolvedValue(false);
      await expect(runUpdate({}, { selfInstall: true, install })).rejects.toMatchObject({ code: 'UPDATE_ERROR' });
    });

    test('npm success that did not change this copy is an UPDATE_ERROR', async () => {
      fetchSpy = registry(72);
      const install = jest.fn().mockResolvedValue(true);
      await expect(
        runUpdate({}, { selfInstall: true, install, versionOnDisk: () => PACKAGE_VERSION })
      ).rejects.toMatchObject({ code: 'UPDATE_ERROR' });
    });

    describe('with the update lock', () => {
      let home: TmpHome;
      beforeEach(async () => {
        home = await createTmpHome();
      });
      afterEach(async () => {
        await home.cleanup();
      });

      test('refuses to install while a background update holds the lock', async () => {
        fetchSpy = registry(72);
        const release = await acquireLock();
        const install = jest.fn().mockResolvedValue(true);
        try {
          await expect(runUpdate({}, { selfInstall: true, install })).rejects.toMatchObject({ code: 'UPDATE_ERROR' });
          expect(install).not.toHaveBeenCalled();
        } finally {
          await release!();
        }
      });

      test('releases the lock after installing, even when npm fails', async () => {
        fetchSpy = registry(72);
        await expect(runUpdate({}, { selfInstall: true, install: jest.fn().mockResolvedValue(false) })).rejects.toMatchObject({ code: 'UPDATE_ERROR' });

        const release = await acquireLock();
        expect(release).not.toBeNull();
        await release!();
      });
    });

    test('--check never installs', async () => {
      fetchSpy = registry(72);
      const install = jest.fn();
      await runUpdate({ check: true }, { selfInstall: true, install });
      expect(install).not.toHaveBeenCalled();
    });
  });
});

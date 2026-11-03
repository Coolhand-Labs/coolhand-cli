import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVersion, isGlobalNpmInstall, maybeAutoUpdate, run as runBackground, type BackgroundDeps } from '../../src/auto-update/index.js';
import { loadState, saveState, statePath } from '../../src/auto-update/state.js';
import { logger } from '../../src/logger.js';
import { PACKAGE_VERSION } from '../../src/version.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

describe('isGlobalNpmInstall', () => {
  test.each([
    '/usr/local/lib/node_modules/coolhand-cli/dist/bin.js',
    '/opt/homebrew/lib/node_modules/coolhand-cli/dist/bin.js',
    '/Users/me/.nvm/versions/node/v22.1.0/lib/node_modules/coolhand-cli/dist/bin.js',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\coolhand-cli\\dist\\bin.js',
  ])('accepts %s', (p) => {
    expect(isGlobalNpmInstall(p)).toBe(true);
  });

  test.each([
    '/home/me/project/node_modules/coolhand-cli/dist/bin.js',
    '/home/me/.npm/_npx/abc123/node_modules/coolhand-cli/dist/bin.js',
    '/home/me/.volta/tools/image/packages/coolhand-cli/lib/node_modules/coolhand-cli/dist/bin.js',
    '/home/me/.local/share/pnpm/global/5/node_modules/coolhand-cli/dist/bin.js',
    '/home/me/src/coolhand-cli/dist/bin.js',
  ])('rejects %s', (p) => {
    expect(isGlobalNpmInstall(p)).toBe(false);
  });
});

describe('maybeAutoUpdate', () => {
  let home: TmpHome;
  let infoSpy: jest.SpyInstance;
  let spawnFn: jest.Mock;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-01T12:00:00Z');

  beforeEach(async () => {
    home = await createTmpHome();
    delete process.env.COOLHAND_NO_AUTO_UPDATE;
    delete process.env.CI;
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    spawnFn = jest.fn().mockReturnValue({ on: jest.fn(), unref: jest.fn() });
  });

  afterEach(async () => {
    process.env.COOLHAND_NO_AUTO_UPDATE = '1';
    delete process.env.CI;
    infoSpy.mockRestore();
    await home.cleanup();
  });

  const call = (command = 'status', json = false) =>
    maybeAutoUpdate({ command, json }, { spawnFn: spawnFn as never, now: NOW, ownScript: true });

  test('first run launches one detached check and stamps last_check', async () => {
    await call();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![1]).toContain('__auto-update');
    expect(spawnFn.mock.calls[0]![2]).toMatchObject({ detached: true, stdio: 'ignore' });
    expect((await loadState()).last_check).toBe(new Date(NOW).toISOString());
  });

  test('does not re-check within 24 hours, and does again after', async () => {
    await saveState({ last_check: new Date(NOW - DAY + 1000).toISOString() });
    await call();
    expect(spawnFn).not.toHaveBeenCalled();

    await saveState({ last_check: new Date(NOW - DAY - 1000).toISOString() });
    await call();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test.each(['__auto-update', '__flush-pending', 'capture-turn', 'update', 'help', 'version', '--version', '-h'])(
    'does nothing for %s',
    async (command) => {
      await call(command);
      expect(spawnFn).not.toHaveBeenCalled();
      await expect(fs.access(statePath())).rejects.toThrow();
    }
  );

  test('COOLHAND_NO_AUTO_UPDATE and CI opt out', async () => {
    process.env.COOLHAND_NO_AUTO_UPDATE = '1';
    await call();
    delete process.env.COOLHAND_NO_AUTO_UPDATE;
    process.env.CI = 'true';
    await call();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('auto_update: false in config.json opts out', async () => {
    await fs.writeFile(`${home.dir}/config.json`, JSON.stringify({ version: 1, clients: {}, auto_update: false }));
    await call();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('announces a completed update once, then clears it', async () => {
    await saveState({ installed: PACKAGE_VERSION, last_check: new Date(NOW).toISOString() });
    await call();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`updated to ${PACKAGE_VERSION}`));
    expect((await loadState()).installed).toBeUndefined();
    infoSpy.mockClear();
    await call();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('announces an available-but-not-installed version once', async () => {
    await saveState({ available: '99.0.0', last_check: new Date(NOW).toISOString() });
    await call();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('npm install -g coolhand-cli@99.0.0'));
    infoSpy.mockClear();
    await call();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('stays quiet under --json but still schedules the check', async () => {
    await saveState({ available: '99.0.0' });
    await call('status', true);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test('defers the "updated" announcement under --json instead of dropping it', async () => {
    await saveState({ installed: PACKAGE_VERSION, last_check: new Date(NOW).toISOString() });
    await call('status', true);
    expect(infoSpy).not.toHaveBeenCalled();
    expect((await loadState()).installed).toBe(PACKAGE_VERSION);
    await call('status', false);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`updated to ${PACKAGE_VERSION}`));
  });

  test.each(['false', '0', ''])('CI=%p does not disable updates', async (value) => {
    process.env.CI = value;
    await call();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test('ignores malformed state fields', async () => {
    await fs.writeFile(
      statePath(),
      JSON.stringify({ last_check: 123, available: {}, installed: '1.2.3-evil', failed: { version: 1 } })
    );
    await expect(call()).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('a last_check in the future does not suppress checks', async () => {
    await saveState({ last_check: new Date(NOW + 30 * DAY).toISOString() });
    await call();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test('spawns the background check from a neutral cwd with an absolute config dir', async () => {
    process.env.COOLHAND_CONFIG_DIR = path.relative(process.cwd(), home.dir);
    await call();
    expect(spawnFn.mock.calls[0]![2]).toMatchObject({
      cwd: os.homedir(),
      env: expect.objectContaining({ COOLHAND_CONFIG_DIR: path.resolve(home.dir) }),
    });
  });

  test('does nothing when there is no command (flag-only invocation)', async () => {
    await maybeAutoUpdate({ command: undefined, json: false }, { spawnFn: spawnFn as never, now: NOW, ownScript: true });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('does nothing when the running script is not this package (embedded run())', async () => {
    await maybeAutoUpdate({ command: 'status', json: false }, { spawnFn: spawnFn as never, now: NOW, ownScript: false });
    expect(spawnFn).not.toHaveBeenCalled();
    await expect(fs.access(statePath())).rejects.toThrow();
  });

  test('a spawn failure never throws', async () => {
    spawnFn.mockImplementation(() => {
      throw new Error('spawn EAGAIN');
    });
    await expect(call()).resolves.toBeUndefined();
  });
});

describe('background run', () => {
  let home: TmpHome;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await home.cleanup();
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  test('records an eligible version as available when this is not a global npm install', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '99.0.0' },
        time: { '99.0.0': hoursAgo(72) },
        versions: { '99.0.0': {} },
      }),
    } as Response);
    await expect(runBackground({ selfInstall: false })).resolves.toBe(0);
    const state = await loadState();
    expect(state.available).toBe('99.0.0');
    expect(state.last_check).toBeDefined();
  });

  test('does not offer a release inside the bake window', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '99.0.0' },
        time: { '99.0.0': hoursAgo(1) },
        versions: { '99.0.0': {} },
      }),
    } as Response);
    await runBackground({ selfInstall: false });
    expect((await loadState()).available).toBeUndefined();
  });

  test('swallows network errors but still records the attempt', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(runBackground({ selfInstall: false })).resolves.toBe(0);
    expect((await loadState()).last_check).toBeDefined();
  });
});

describe('background run with injected install', () => {
  let home: TmpHome;
  let fetchFn: jest.Mock;

  beforeEach(async () => {
    home = await createTmpHome();
    fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '99.0.0' },
        time: { '99.0.0': new Date(Date.now() - 72 * 3600 * 1000).toISOString() },
        versions: { '99.0.0': {} },
      }),
    });
  });

  afterEach(async () => {
    delete process.env.COOLHAND_UPDATE_REGISTRY;
    await home.cleanup();
  });

  const deps = (over: Partial<BackgroundDeps>): BackgroundDeps => ({
    selfInstall: true,
    // Never reach the real `npm install -g`; tests that care override these.
    install: jest.fn().mockResolvedValue(false),
    versionOnDisk: () => undefined,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...over,
  });

  test('records installed only when the files on disk report the new version', async () => {
    const install = jest.fn().mockResolvedValue(true);
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    expect(install).toHaveBeenCalledWith('99.0.0');
    const state = await loadState();
    expect(state.installed).toBe('99.0.0');
    expect(state.available).toBeUndefined();
    expect(state.failed).toBeUndefined();
  });

  test('a "successful" install that left the running copy unchanged counts as failed', async () => {
    await runBackground(deps({ install: jest.fn().mockResolvedValue(true), versionOnDisk: () => PACKAGE_VERSION }));
    const state = await loadState();
    expect(state.installed).toBeUndefined();
    expect(state.available).toBe('99.0.0');
    expect(state.failed?.version).toBe('99.0.0');
  });

  test('does not retry a version that already failed', async () => {
    await saveState({ failed: { version: '99.0.0', at: new Date().toISOString() } });
    const install = jest.fn().mockResolvedValue(true);
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    expect(install).not.toHaveBeenCalled();
    expect((await loadState()).available).toBe('99.0.0');
  });

  test('retries a failed version after a week', async () => {
    await saveState({ failed: { version: '99.0.0', at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() } });
    const install = jest.fn().mockResolvedValue(true);
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    expect(install).toHaveBeenCalledWith('99.0.0');
  });

  test('keeps fields written by foreground launches while the install ran', async () => {
    const install = jest.fn().mockImplementation(async () => {
      await saveState({ notified: '98.0.0', last_check: 'concurrent' });
      return true;
    });
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    const state = await loadState();
    expect(state.notified).toBe('98.0.0');
    expect(state.installed).toBe('99.0.0');
  });

  test('a pending installed notice survives a later check that finds nothing new', async () => {
    await saveState({ installed: '99.0.0' });
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.0' }, versions: {} }) });
    await runBackground(deps({}));
    expect((await loadState()).installed).toBe('99.0.0');
  });

  test('uses COOLHAND_UPDATE_REGISTRY for the check, and npmjs when unset', async () => {
    process.env.COOLHAND_UPDATE_REGISTRY = 'http://127.0.0.1:4873/';
    await runBackground(deps({}));
    expect(fetchFn.mock.calls[0]![0]).toBe('http://127.0.0.1:4873/coolhand-cli');
    delete process.env.COOLHAND_UPDATE_REGISTRY;
    await runBackground(deps({}));
    expect(fetchFn.mock.calls[1]![0]).toBe('https://registry.npmjs.org/coolhand-cli');
  });

  test('an invalid COOLHAND_UPDATE_REGISTRY never falls back to npmjs', async () => {
    process.env.COOLHAND_UPDATE_REGISTRY = 'http://evil.example.com';
    await runBackground(deps({}));
    expect(fetchFn).not.toHaveBeenCalled();
    delete process.env.COOLHAND_UPDATE_REGISTRY;
  });

  test('only one background job runs at a time', async () => {
    const lock = `${home.dir}/update.lock`;
    await fs.writeFile(lock, '');
    const install = jest.fn().mockResolvedValue(true);
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    // A lock left by a crashed job is taken over once stale, and released afterwards.
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await fs.utimes(lock, old, old);
    await runBackground(deps({ install, versionOnDisk: () => '99.0.0' }));
    expect(install).toHaveBeenCalledWith('99.0.0');
    await expect(fs.access(lock)).rejects.toThrow();
  });
});

describe('installVersion', () => {
  const fakeChild = (event: 'close' | 'error', arg: unknown) => {
    const handlers: Record<string, (a: unknown) => void> = {};
    const child = {
      on: (name: string, fn: (a: unknown) => void) => {
        handlers[name] = fn;
        if (name === event) {
          setImmediate(() => fn(arg));
        }
        return child;
      },
    };
    return child;
  };

  afterEach(() => {
    delete process.env.COOLHAND_UPDATE_REGISTRY;
  });

  test('pins the exact version with --before and hides the window', async () => {
    const spawnFn = jest.fn().mockReturnValue(fakeChild('close', 0));
    const ok = await installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never, userHasBake: async () => false });
    expect(ok).toBe(true);
    const [, args, options] = spawnFn.mock.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['install', '-g']);
    expect(args[args.length - 1]).toBe('coolhand-cli@1.2.3');
    const before = args.find((a: string) => a.startsWith('--before='))!;
    const age = Date.now() - Date.parse(before.slice('--before='.length));
    expect(age).toBeGreaterThanOrEqual(48 * 3600 * 1000 - 5000);
    // Not the user's cwd: a project .npmrc there must not influence the install.
    expect(options).toMatchObject({ stdio: 'ignore', windowsHide: true, cwd: os.homedir() });
  });

  test('omits --before when the user npm config already sets a bake', async () => {
    const spawnFn = jest.fn().mockReturnValue(fakeChild('close', 0));
    await installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never, userHasBake: async () => true });
    expect(spawnFn.mock.calls[0]![1].some((a: string) => a.startsWith('--before'))).toBe(false);
  });

  test('passes through stdio and an overridden registry, and rejects an invalid one', async () => {
    const spawnFn = jest.fn().mockImplementation(() => fakeChild('close', 0));
    process.env.COOLHAND_UPDATE_REGISTRY = 'http://127.0.0.1:4873';
    await installVersion('1.2.3', ['ignore', 'ignore', 'inherit'], { spawnFn: spawnFn as never, userHasBake: async () => false });
    expect(spawnFn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--registry', 'http://127.0.0.1:4873']));
    expect(spawnFn.mock.calls[0]![2].stdio).toEqual(['ignore', 'ignore', 'inherit']);

    for (const bad of ['https://registry.example.com/?x=1', 'https://registry.example.com/#frag']) {
      process.env.COOLHAND_UPDATE_REGISTRY = bad;
      await expect(
        installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never, userHasBake: async () => false })
      ).rejects.toThrow(/COOLHAND_UPDATE_REGISTRY/);
    }

    process.env.COOLHAND_UPDATE_REGISTRY = 'https://user:pw@registry.example.com';
    await expect(
      installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never, userHasBake: async () => false })
    ).rejects.toThrow(/COOLHAND_UPDATE_REGISTRY/);
  });

  test('resolves false on a non-zero exit, a spawn error, or a thrown spawn', async () => {
    const deps = (spawnFn: jest.Mock) => ({ spawnFn: spawnFn as never, userHasBake: async () => false });
    expect(await installVersion('1.2.3', 'ignore', deps(jest.fn().mockReturnValue(fakeChild('close', 1))))).toBe(false);
    expect(await installVersion('1.2.3', 'ignore', deps(jest.fn().mockReturnValue(fakeChild('error', new Error('ENOENT')))))).toBe(false);
    expect(
      await installVersion('1.2.3', 'ignore', deps(jest.fn().mockImplementation(() => { throw new Error('boom'); })))
    ).toBe(false);
  });

  describe('npm config detection', () => {
    // Routes `npm config get <key>` to canned stdout; everything else (the install) succeeds.
    const router = (values: Record<string, string>) =>
      jest.fn().mockImplementation((_cmd: string, args: string[]) => {
        const handlers: Record<string, (a: unknown) => void> = {};
        const dataHandlers: Array<(c: Buffer) => void> = [];
        const isGet = args.includes('config');
        const child = {
          stdout: { on: (_: string, fn: (c: Buffer) => void) => dataHandlers.push(fn) },
          on: (name: string, fn: (a: unknown) => void) => {
            handlers[name] = fn;
            if (name === 'close') {
              setImmediate(() => {
                if (isGet) {
                  dataHandlers.forEach((d) => d(Buffer.from(`${values[args[args.length - 1]!] ?? 'undefined'}\n`)));
                }
                fn(0);
              });
            }
            return child;
          },
        };
        return child;
      });

    const installArgs = (spawnFn: jest.Mock) => spawnFn.mock.calls.map((c) => c[1] as string[]).find((a) => a.includes('install'))!;

    test.each([
      [{}, true],
      [{ 'min-release-age': '0' }, true],
      [{ 'min-release-age': 'null' }, true],
      [{ 'min-release-age': '2' }, false],
      [{ before: '2026-01-01T00:00:00.000Z' }, false],
    ])('npm config %j → --before added: %p', async (values, expectBefore) => {
      const spawnFn = router(values as Record<string, string>);
      expect(await installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never })).toBe(true);
      expect(installArgs(spawnFn).some((a) => a.startsWith('--before='))).toBe(expectBefore);
    });

    test('a failing `npm config get` leaves --before on', async () => {
      const spawnFn = jest.fn().mockImplementation((_c: string, args: string[]) => {
        if (args.includes('config')) {
          throw new Error('spawn failed');
        }
        return fakeChild('close', 0);
      });
      await installVersion('1.2.3', 'ignore', { spawnFn: spawnFn as never });
      expect(installArgs(spawnFn).some((a) => a.startsWith('--before='))).toBe(true);
    });
  });
});

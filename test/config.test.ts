import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  atomicWriteFile,
  configDir,
  configPath,
  deleteConfig,
  getClient,
  loadConfig,
  removeClient,
  resolveClient,
  saveConfig,
  setDefault,
  upsertClient,
} from '../src/config.js';
import { CliError } from '../src/errors.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';

// Mock readline so promptClientSelection can be driven in TTY tests.
jest.mock('readline', () => ({ createInterface: jest.fn() }));
import * as readline from 'readline';

// Suppress "Client: ..." label output so it doesn't pollute test output.
// Use beforeEach/afterEach so the spy is always properly restored between tests.
let stderrSpy: jest.SpyInstance;
beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
});

describe('config', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  function makeEntry(id: string) {
    return {
      client_id: id,
      client_name: `Client ${id}`,
      api_key: `ch_pub_${id.repeat(4)}xxxx`,
      base_url: 'https://coolhandlabs.com',
      saved_at: new Date().toISOString(),
    };
  }

  test('loadConfig returns empty default when file is missing', async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual({ version: 1, default_client_id: null, clients: {} });
  });

  test('saveConfig writes parseable JSON', async () => {
    await saveConfig({ version: 1, default_client_id: 'a', clients: { a: makeEntry('a') } });
    const cfg = await loadConfig();
    expect(cfg.default_client_id).toBe('a');
    expect(cfg.clients.a.api_key).toContain('ch_pub_');
  });

  test('saveConfig writes file with mode 0o600 (POSIX)', async () => {
    if (process.platform === 'win32') {
      return;
    }
    await saveConfig({ version: 1, default_client_id: null, clients: {} });
    const stat = await fs.stat(configPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('upsertClient adds entry and sets default when requested', async () => {
    await upsertClient(makeEntry('a'), true);
    const cfg = await loadConfig();
    expect(cfg.clients.a).toBeDefined();
    expect(cfg.default_client_id).toBe('a');
  });

  test('upsertClient overwrites existing entry with same id', async () => {
    await upsertClient(makeEntry('a'), true);
    const next = { ...makeEntry('a'), client_name: 'Renamed' };
    await upsertClient(next, false);
    const cfg = await loadConfig();
    expect(cfg.clients.a.client_name).toBe('Renamed');
  });

  test('removeClient last entry deletes the file', async () => {
    await upsertClient(makeEntry('a'), true);
    const result = await removeClient('a');
    expect(result).toBeNull();
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('removeClient with remaining clients re-assigns default', async () => {
    await upsertClient(makeEntry('a'), true);
    await upsertClient(makeEntry('b'), false);
    const cfg = (await removeClient('a'))!;
    expect(cfg.default_client_id).toBe('b');
  });

  test('removeClient unknown id is a no-op', async () => {
    await upsertClient(makeEntry('a'), true);
    const cfg = (await removeClient('missing'))!;
    expect(cfg.clients.a).toBeDefined();
  });

  test('setDefault rejects unknown client', async () => {
    await upsertClient(makeEntry('a'), true);
    await expect(setDefault('nope')).rejects.toBeInstanceOf(CliError);
  });

  test('getClient falls back to default when id missing', async () => {
    await upsertClient(makeEntry('a'), true);
    const cfg = await loadConfig();
    expect(getClient(cfg)?.client_id).toBe('a');
    expect(getClient(cfg, 'a')?.client_id).toBe('a');
    expect(getClient(cfg, 'missing')).toBeUndefined();
  });

  test('deleteConfig is idempotent', async () => {
    await deleteConfig();
    await deleteConfig();
  });

  test('malformed JSON yields CliError', async () => {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(path.join(configDir(), 'config.json'), '{not json');
    await expect(loadConfig()).rejects.toMatchObject({ code: 'CONFIG_READ_FAILED' });
  });

  describe('atomicWriteFile', () => {
    test('writes the exact contents to the target path', async () => {
      await fs.mkdir(configDir(), { recursive: true });
      const target = path.join(configDir(), 'note.txt');
      await atomicWriteFile(target, 'hello world');
      expect(await fs.readFile(target, 'utf8')).toBe('hello world');
    });

    test('leaves no temp files behind on success', async () => {
      await fs.mkdir(configDir(), { recursive: true });
      const target = path.join(configDir(), 'note.txt');
      await atomicWriteFile(target, 'data');
      const leftovers = (await fs.readdir(configDir())).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    test('applies the requested mode on POSIX', async () => {
      if (process.platform === 'win32') {
        return;
      }
      await fs.mkdir(configDir(), { recursive: true });
      const target = path.join(configDir(), 'secret.txt');
      await atomicWriteFile(target, 'shh', 0o600);
      const stat = await fs.stat(target);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    test('rejects with CONFIG_WRITE_FAILED when the directory does not exist', async () => {
      const target = path.join(configDir(), 'no-such-dir', 'file.txt');
      await expect(atomicWriteFile(target, 'data')).rejects.toMatchObject({
        code: 'CONFIG_WRITE_FAILED',
      });
    });
  });
});

describe('resolveClient', () => {
  const entry = (id: string) => ({
    client_id: id,
    client_name: `Client ${id}`,
    api_key: `key_${id}`,
    base_url: 'https://coolhandlabs.com',
    saved_at: '2026-01-01T00:00:00Z',
  });

  const cfg = (clients: Record<string, ReturnType<typeof entry>>, defaultId: string | null = null) => ({
    version: 1 as const,
    default_client_id: defaultId,
    clients,
  });

  beforeEach(() => {
    delete process.env.COOLHAND_CLIENT_ID;
  });

  afterEach(() => {
    delete process.env.COOLHAND_CLIENT_ID;
  });

  test('resolves explicit clientId', async () => {
    const a = entry('a');
    const result = await resolveClient(cfg({ a }, 'a'), 'a');
    expect(result).toEqual(a);
  });

  test('throws CLIENT_NOT_FOUND for unknown explicit clientId', async () => {
    await expect(resolveClient(cfg({}), 'missing')).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('resolves via COOLHAND_CLIENT_ID env var', async () => {
    process.env.COOLHAND_CLIENT_ID = 'acme';
    const acme = entry('acme');
    const result = await resolveClient(cfg({ acme }));
    expect(result).toEqual(acme);
  });

  test('throws CLIENT_NOT_FOUND when COOLHAND_CLIENT_ID does not match any client', async () => {
    process.env.COOLHAND_CLIENT_ID = 'nope';
    await expect(resolveClient(cfg({}))).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('resolves via default_client_id', async () => {
    const a = entry('a');
    const result = await resolveClient(cfg({ a }, 'a'));
    expect(result).toEqual(a);
  });

  test('auto-picks when exactly one client exists and no default is set', async () => {
    const solo = entry('solo');
    const result = await resolveClient(cfg({ solo }));
    expect(result).toEqual(solo);
  });

  test('throws NOT_CONFIGURED when no clients exist', async () => {
    await expect(resolveClient(cfg({}))).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  test('warns when default_client_id is stale and falls through to auto-pick', async () => {
    stderrSpy.mockClear(); // reset call history accumulated from beforeEach
    const solo = entry('solo');
    // default_client_id points to a client that no longer exists
    const result = await resolveClient(cfg({ solo }, 'deleted'));
    expect(result).toEqual(solo);
    // stderr should have received both the stale-default warning and the resolution label
    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toMatch(/no longer exists/);
    expect(calls).toMatch(/Client: Client solo \(solo\)/);
  });

  test('throws NOT_CONFIGURED with client list when multiple clients exist and stdin is not a TTY', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const a = entry('a');
      const b = entry('b');
      const err = await resolveClient(cfg({ a, b })).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('NOT_CONFIGURED');
      expect((err as CliError).message).toContain('a');
      expect((err as CliError).message).toContain('b');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  test('throws NOT_CONFIGURED with client list when multiple clients exist and stderr is not a TTY (stdin is a TTY)', async () => {
    const origStdinIsTTY = process.stdin.isTTY;
    const origStderrIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    try {
      const a = entry('a');
      const b = entry('b');
      const err = await resolveClient(cfg({ a, b })).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('NOT_CONFIGURED');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origStdinIsTTY, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: origStderrIsTTY, configurable: true });
    }
  });

  test('explicit clientId takes priority over COOLHAND_CLIENT_ID env var', async () => {
    process.env.COOLHAND_CLIENT_ID = 'b';
    const a = entry('a');
    const b = entry('b');
    const result = await resolveClient(cfg({ a, b }), 'a');
    expect(result).toEqual(a);
  });

  describe('interactive prompt (TTY)', () => {
    let mockRl: EventEmitter & { close: jest.Mock };
    let pauseSpy: jest.SpyInstance;
    const origStdinIsTTY = process.stdin.isTTY;
    const origStderrIsTTY = process.stderr.isTTY;

    beforeEach(() => {
      (readline.createInterface as jest.Mock).mockImplementation(() => {
        const emitter = new EventEmitter() as EventEmitter & { close: jest.Mock };
        emitter.close = jest.fn(() => { emitter.emit('close'); });
        mockRl = emitter;
        return mockRl;
      });
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
      pauseSpy = jest.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
    });

    afterEach(() => {
      (readline.createInterface as jest.Mock).mockReset();
      Object.defineProperty(process.stdin, 'isTTY', { value: origStdinIsTTY, configurable: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: origStderrIsTTY, configurable: true });
      pauseSpy.mockRestore();
    });

    test('resolves with chosen client on valid numeric input', async () => {
      const a = entry('a');
      const b = entry('b');
      const promise = resolveClient(cfg({ a, b }));
      setImmediate(() => mockRl.emit('line', '1'));
      expect(await promise).toEqual(a);
      expect(pauseSpy).toHaveBeenCalled();
    });

    test('rejects INVALID_ARGS on out-of-range selection', async () => {
      const a = entry('a');
      const b = entry('b');
      const promise = resolveClient(cfg({ a, b }));
      setImmediate(() => mockRl.emit('line', '5'));
      await expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      expect(pauseSpy).toHaveBeenCalled();
    });

    test('rejects INVALID_ARGS when stdin closes before selection', async () => {
      const a = entry('a');
      const b = entry('b');
      const promise = resolveClient(cfg({ a, b }));
      setImmediate(() => mockRl.emit('close'));
      await expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      expect(pauseSpy).toHaveBeenCalled();
    });

    test('rejects INVALID_ARGS and pauses stdin when the 30-second timeout fires', async () => {
      jest.useFakeTimers();
      try {
        const a = entry('a');
        const b = entry('b');
        const promise = resolveClient(cfg({ a, b }));
        // Advance past the 30s prompt timeout.
        jest.advanceTimersByTime(31_000);
        await expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGS' });
        expect(pauseSpy).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

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
  saveConfig,
  setDefault,
  upsertClient,
} from '../src/config.js';
import { CliError } from '../src/errors.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';

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

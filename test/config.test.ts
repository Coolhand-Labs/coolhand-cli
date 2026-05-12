import { promises as fs } from 'fs';
import * as path from 'path';
import {
  configDir,
  configPath,
  deleteConfig,
  getAccount,
  loadConfig,
  removeAccount,
  saveConfig,
  setDefault,
  upsertAccount,
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
      account_id: id,
      account_name: `Account ${id}`,
      api_key: `ch_pub_${id.repeat(4)}xxxx`,
      base_url: 'https://coolhandlabs.com',
      saved_at: new Date().toISOString(),
    };
  }

  test('loadConfig returns empty default when file is missing', async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual({ version: 1, default_account_id: null, accounts: {} });
  });

  test('saveConfig writes parseable JSON', async () => {
    await saveConfig({ version: 1, default_account_id: 'a', accounts: { a: makeEntry('a') } });
    const cfg = await loadConfig();
    expect(cfg.default_account_id).toBe('a');
    expect(cfg.accounts.a.api_key).toContain('ch_pub_');
  });

  test('saveConfig writes file with mode 0o600 (POSIX)', async () => {
    if (process.platform === 'win32') {
      return;
    }
    await saveConfig({ version: 1, default_account_id: null, accounts: {} });
    const stat = await fs.stat(configPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('upsertAccount adds entry and sets default when requested', async () => {
    await upsertAccount(makeEntry('a'), true);
    const cfg = await loadConfig();
    expect(cfg.accounts.a).toBeDefined();
    expect(cfg.default_account_id).toBe('a');
  });

  test('upsertAccount overwrites existing entry with same id', async () => {
    await upsertAccount(makeEntry('a'), true);
    const next = { ...makeEntry('a'), account_name: 'Renamed' };
    await upsertAccount(next, false);
    const cfg = await loadConfig();
    expect(cfg.accounts.a.account_name).toBe('Renamed');
  });

  test('removeAccount last entry deletes the file', async () => {
    await upsertAccount(makeEntry('a'), true);
    const result = await removeAccount('a');
    expect(result).toBeNull();
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('removeAccount with remaining accounts re-assigns default', async () => {
    await upsertAccount(makeEntry('a'), true);
    await upsertAccount(makeEntry('b'), false);
    const cfg = (await removeAccount('a'))!;
    expect(cfg.default_account_id).toBe('b');
  });

  test('removeAccount unknown id is a no-op', async () => {
    await upsertAccount(makeEntry('a'), true);
    const cfg = (await removeAccount('missing'))!;
    expect(cfg.accounts.a).toBeDefined();
  });

  test('setDefault rejects unknown account', async () => {
    await upsertAccount(makeEntry('a'), true);
    await expect(setDefault('nope')).rejects.toBeInstanceOf(CliError);
  });

  test('getAccount falls back to default when id missing', async () => {
    await upsertAccount(makeEntry('a'), true);
    const cfg = await loadConfig();
    expect(getAccount(cfg)?.account_id).toBe('a');
    expect(getAccount(cfg, 'a')?.account_id).toBe('a');
    expect(getAccount(cfg, 'missing')).toBeUndefined();
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
});

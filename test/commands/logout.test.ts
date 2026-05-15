import { promises as fs } from 'fs';
import { run as runLogout } from '../../src/commands/logout.js';
import { loadConfig, upsertClient, configPath } from '../../src/config.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

function makeEntry(id: string) {
  return {
    client_id: id,
    client_name: `Client ${id}`,
    api_key: `ch_pub_${id.repeat(4)}xxxx`,
    base_url: 'https://coolhandlabs.com',
    saved_at: new Date().toISOString(),
  };
}

describe('logout command', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('--all wipes the config file', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runLogout({ all: true });
    expect(code).toBe(0);
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('--all is idempotent when no config exists', async () => {
    const code = await runLogout({ all: true });
    expect(code).toBe(0);
  });

  test('removes specific client by id and re-assigns default', async () => {
    await upsertClient(makeEntry('a'), true);
    await upsertClient(makeEntry('b'), false);
    const code = await runLogout({ clientId: 'a' });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.clients.a).toBeUndefined();
    expect(cfg.default_client_id).toBe('b');
  });

  test('removing missing client is a no-op', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runLogout({ clientId: 'missing' });
    expect(code).toBe(0);
  });

  test('with no args removes the default client', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runLogout({});
    expect(code).toBe(0);
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

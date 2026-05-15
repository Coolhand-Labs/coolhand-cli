import { run as runClients } from '../../src/commands/clients.js';
import { loadConfig, upsertClient } from '../../src/config.js';
import { CliError } from '../../src/errors.js';
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

describe('clients command', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('list with no clients returns 0', async () => {
    const code = await runClients([], { json: true });
    expect(code).toBe(0);
  });

  test('list with clients returns 0', async () => {
    await upsertClient(makeEntry('a'), true);
    await upsertClient(makeEntry('b'), false);
    const code = await runClients([], { json: true });
    expect(code).toBe(0);
  });

  test('use sets new default', async () => {
    await upsertClient(makeEntry('a'), true);
    await upsertClient(makeEntry('b'), false);
    const code = await runClients(['use', 'b'], { json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.default_client_id).toBe('b');
  });

  test('use with missing id throws CliError', async () => {
    await upsertClient(makeEntry('a'), true);
    await expect(runClients(['use', 'nope'], {})).rejects.toBeInstanceOf(CliError);
  });

  test('use without id throws CliError', async () => {
    await expect(runClients(['use'], {})).rejects.toBeInstanceOf(CliError);
  });

  test('unknown subcommand throws CliError', async () => {
    await expect(runClients(['something'], {})).rejects.toBeInstanceOf(CliError);
  });
});

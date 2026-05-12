import { run as runAccounts } from '../../src/commands/accounts.js';
import { loadConfig, upsertAccount } from '../../src/config.js';
import { CliError } from '../../src/errors.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

function makeEntry(id: string) {
  return {
    account_id: id,
    account_name: `Acct ${id}`,
    api_key: `ch_pub_${id.repeat(4)}xxxx`,
    base_url: 'https://coolhandlabs.com',
    saved_at: new Date().toISOString(),
  };
}

describe('accounts command', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('list with no accounts returns 0', async () => {
    const code = await runAccounts([], { json: true });
    expect(code).toBe(0);
  });

  test('list with accounts returns 0', async () => {
    await upsertAccount(makeEntry('a'), true);
    await upsertAccount(makeEntry('b'), false);
    const code = await runAccounts([], { json: true });
    expect(code).toBe(0);
  });

  test('use sets new default', async () => {
    await upsertAccount(makeEntry('a'), true);
    await upsertAccount(makeEntry('b'), false);
    const code = await runAccounts(['use', 'b'], { json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.default_account_id).toBe('b');
  });

  test('use with missing id throws CliError', async () => {
    await upsertAccount(makeEntry('a'), true);
    await expect(runAccounts(['use', 'nope'], {})).rejects.toBeInstanceOf(CliError);
  });

  test('use without id throws CliError', async () => {
    await expect(runAccounts(['use'], {})).rejects.toBeInstanceOf(CliError);
  });

  test('unknown subcommand throws CliError', async () => {
    await expect(runAccounts(['something'], {})).rejects.toBeInstanceOf(CliError);
  });
});

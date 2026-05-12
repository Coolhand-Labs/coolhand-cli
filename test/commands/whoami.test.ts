import { run as runWhoami } from '../../src/commands/whoami.js';
import { upsertAccount } from '../../src/config.js';
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

describe('whoami command', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('returns 1 when not configured', async () => {
    const code = await runWhoami({});
    expect(code).toBe(1);
  });

  test('returns 0 for the default account', async () => {
    await upsertAccount(makeEntry('a'), true);
    const code = await runWhoami({});
    expect(code).toBe(0);
  });

  test('returns 1 for an unknown account-id', async () => {
    await upsertAccount(makeEntry('a'), true);
    const code = await runWhoami({ accountId: 'nope' });
    expect(code).toBe(1);
  });
});

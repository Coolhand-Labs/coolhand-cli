import { run as runStatus } from '../../src/commands/status.js';
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

describe('status command', () => {
  let home: TmpHome;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  test('no config returns 1', async () => {
    const code = await runStatus({ json: true });
    expect(code).toBe(1);
  });

  test('configured account returns 0', async () => {
    await upsertAccount(makeEntry('a'), true);
    const code = await runStatus({ json: true });
    expect(code).toBe(0);
  });

  test('account-id matching configured returns 0', async () => {
    await upsertAccount(makeEntry('a'), true);
    const code = await runStatus({ accountId: 'a' });
    expect(code).toBe(0);
  });

  test('account-id not matching returns 1', async () => {
    await upsertAccount(makeEntry('a'), true);
    const code = await runStatus({ accountId: 'missing' });
    expect(code).toBe(1);
  });
});

import { run as runStatus, buildStatusOutput } from '../../src/commands/status.js';
import { loadConfig, upsertClient } from '../../src/config.js';
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

  test('configured client returns 0', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runStatus({ json: true });
    expect(code).toBe(0);
  });

  test('client-id matching configured returns 0', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runStatus({ clientId: 'a' });
    expect(code).toBe(0);
  });

  test('client-id not matching returns 1', async () => {
    await upsertClient(makeEntry('a'), true);
    const code = await runStatus({ clientId: 'missing' });
    expect(code).toBe(1);
  });

  test('buildStatusOutput reports masked_private_key when a private key is stored', async () => {
    await upsertClient({ ...makeEntry('a'), private_key: 'ch_priv_aaaaaaaaaaaaaaaa' }, true);
    const cfg = await loadConfig();
    const output = buildStatusOutput(cfg);
    expect(output.clients[0].masked_private_key).not.toBe('(no private key)');
  });

  test('buildStatusOutput reports no private key when none is stored', async () => {
    await upsertClient(makeEntry('a'), true);
    const cfg = await loadConfig();
    const output = buildStatusOutput(cfg);
    expect(output.clients[0].masked_private_key).toBe('(no private key)');
  });
});

import { promises as fs } from 'fs';
import * as path from 'path';
import { run as runLogin } from '../../src/commands/login.js';
import { loadConfig, configPath } from '../../src/config.js';
import { startFakeRails, deliverCallback, FakeRails } from '../helpers/fake-rails.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

jest.mock('../../src/auth/open-browser.js', () => ({
  openBrowser: jest.fn().mockResolvedValue(undefined),
}));
import { openBrowser } from '../../src/auth/open-browser.js';

describe('login command', () => {
  let home: TmpHome;
  let rails: FakeRails | undefined;

  beforeEach(async () => {
    home = await createTmpHome();
    (openBrowser as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rails?.close();
    rails = undefined;
    await home.cleanup();
  });

  test('happy path writes config and returns 0', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_HAPPYPATHTOKEN12345678',
      state,
      accountName: 'Acme Inc',
      accountId: 'acme',
    }));

    // Wire openBrowser to actually trigger the redirect by hitting the fake-rails URL.
    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.default_account_id).toBe('acme');
    expect(cfg.accounts.acme.api_key).toBe('ch_pub_HAPPYPATHTOKEN12345678');
    expect(cfg.accounts.acme.base_url).toBe(rails.url);
  });

  test('state mismatch causes failure without writing config', async () => {
    rails = await startFakeRails(() => ({
      token: 'ch_pub_BADBADBADBADBADBADBADBAD',
      state: 'wrong_state',
      accountName: 'X',
      accountId: 'x',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, timeoutMs: 1000 });
    expect(code).not.toBe(0);
    await expect(fs.stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('missing token rejects with non-zero exit', async () => {
    rails = await startFakeRails(({ state }) => ({
      state,
      accountName: 'X',
      accountId: 'x',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, timeoutMs: 1000 });
    expect(code).not.toBe(0);
  });

  test('timeout when nothing happens', async () => {
    (openBrowser as jest.Mock).mockImplementation(async () => undefined);
    const code = await runLogin({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 });
    expect(code).not.toBe(0);
  });

  test('writeEnv creates target file with key', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_ENVWRITERTOKEN1234567',
      state,
      accountName: 'Env Acct',
      accountId: 'envacct',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const envPath = path.join(home.dir, '.env');
    const code = await runLogin({ baseUrl: rails.url, writeEnv: envPath, json: true });
    expect(code).toBe(0);
    const contents = await fs.readFile(envPath, 'utf8');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_ENVWRITERTOKEN1234567');
  });

  test('rejects invalid baseUrl', async () => {
    const code = await runLogin({ baseUrl: 'file:///etc/passwd', timeoutMs: 100 });
    expect(code).not.toBe(0);
  });

  // Use deliverCallback directly to avoid the fake-rails dance.
  test('deliverCallback with valid params succeeds', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_DELIVERCALLBACKVALID000',
      state,
      accountName: 'Direct',
      accountId: 'direct',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri')!;
      const state = parsed.searchParams.get('state')!;
      await deliverCallback(redirectUri, {
        token: 'ch_pub_DELIVERCALLBACKVALID000',
        state,
        accountName: 'Direct',
        accountId: 'direct',
      });
    });

    const code = await runLogin({ baseUrl: rails.url, json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.accounts.direct.account_name).toBe('Direct');
  });
});

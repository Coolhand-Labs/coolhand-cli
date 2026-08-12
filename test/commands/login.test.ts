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

jest.mock('../../src/prompt.js', () => ({ confirm: jest.fn() }));
jest.mock('../../src/commands/flush-pending.js', () => ({ spawnBackgroundFlush: jest.fn() }));
import { confirm } from '../../src/prompt.js';
import { spawnBackgroundFlush } from '../../src/commands/flush-pending.js';
import { savePendingRecord } from '../../src/pending-store.js';

describe('login command', () => {
  let home: TmpHome;
  let rails: FakeRails | undefined;

  beforeEach(async () => {
    home = await createTmpHome();
    (openBrowser as jest.Mock).mockReset().mockResolvedValue(undefined);
    (confirm as jest.Mock).mockReset().mockResolvedValue(false);
    (spawnBackgroundFlush as jest.Mock).mockReset();
  });

  function wireRedirect(): void {
    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });
  }

  afterEach(async () => {
    await rails?.close();
    rails = undefined;
    await home.cleanup();
  });

  test('happy path writes config and returns 0', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_HAPPYPATHTOKEN12345678',
      state,
      clientName: 'Acme Inc',
      clientId: 'acme',
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
    expect(cfg.default_client_id).toBe('acme');
    expect(cfg.clients.acme.api_key).toBe('ch_pub_HAPPYPATHTOKEN12345678');
    expect(cfg.clients.acme.base_url).toBe(rails.url);
  });

  test('state mismatch causes failure without writing config', async () => {
    rails = await startFakeRails(() => ({
      token: 'ch_pub_BADBADBADBADBADBADBADBAD',
      state: 'wrong_state',
      clientName: 'X',
      clientId: 'x',
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
      clientName: 'X',
      clientId: 'x',
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
      clientName: 'Env Acct',
      clientId: 'envacct',
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

  test('rejects http baseUrl for a non-loopback host', async () => {
    const code = await runLogin({ baseUrl: 'http://internal-mirror.corp', timeoutMs: 100 });
    expect(code).not.toBe(0);
  });

  test('--scope private stores private_key in config', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_SCOPEPUBTOKEN1234567890',
      state,
      clientName: 'Scope Acct',
      clientId: 'scopeacct',
      private_token: 'ch_priv_SCOPEPRIVTOKEN123456789',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('scope')).toBe('private');
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, scope: 'private', json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.clients.scopeacct.api_key).toBe('ch_pub_SCOPEPUBTOKEN1234567890');
    expect(cfg.clients.scopeacct.private_key).toBe('ch_priv_SCOPEPRIVTOKEN123456789');
  });

  test('a later public-only login preserves the previously-stored private_key', async () => {
    const railsPrivate = await startFakeRails(({ state }) => ({
      token: 'ch_pub_MERGEPUBTOKEN123456789',
      state,
      clientName: 'Merge Acct',
      clientId: 'mergeacct',
      private_token: 'ch_priv_MERGEPRIVTOKEN12345678',
    }));
    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });
    const firstCode = await runLogin({ baseUrl: railsPrivate.url, scope: 'private', json: true });
    expect(firstCode).toBe(0);
    await railsPrivate.close();

    let cfg = await loadConfig();
    expect(cfg.clients.mergeacct.private_key).toBe('ch_priv_MERGEPRIVTOKEN12345678');

    // Plain `login` (no --scope private) against the same client_id: the callback
    // returns only a public token, so private_key must survive the upsert.
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_MERGEPUBTOKENROTATED0',
      state,
      clientName: 'Merge Acct',
      clientId: 'mergeacct',
    }));
    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });
    const secondCode = await runLogin({ baseUrl: rails.url, json: true });
    expect(secondCode).toBe(0);

    cfg = await loadConfig();
    expect(cfg.clients.mergeacct.api_key).toBe('ch_pub_MERGEPUBTOKENROTATED0');
    expect(cfg.clients.mergeacct.private_key).toBe('ch_priv_MERGEPRIVTOKEN12345678');
  });

  test('--scope private proceeds when private_token absent, stores only public key', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_NOPRIVTOKEN1234567890',
      state,
      clientName: 'No Priv',
      clientId: 'nopriv',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, scope: 'private', json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.clients.nopriv.api_key).toBe('ch_pub_NOPRIVTOKEN1234567890');
    expect(cfg.clients.nopriv.private_key).toBeUndefined();
  });

  test('only private_token returned stores private_key without api_key', async () => {
    rails = await startFakeRails(({ state }) => ({
      private_token: 'ch_priv_ONLYPRIVTOKEN123456789',
      state,
      clientName: 'Priv Only',
      clientId: 'privonly',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const code = await runLogin({ baseUrl: rails.url, scope: 'private', json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.clients.privonly.api_key).toBeUndefined();
    expect(cfg.clients.privonly.private_key).toBe('ch_priv_ONLYPRIVTOKEN123456789');
  });

  test('--scope private --write-env writes both keys to env file', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_ENVPUBTOKEN12345678901',
      state,
      clientName: 'Env Scope',
      clientId: 'envscope',
      private_token: 'ch_priv_ENVPRIVTOKEN1234567890',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) {
        await fetch(location).catch(() => undefined);
      }
    });

    const envPath = path.join(home.dir, '.env');
    const code = await runLogin({ baseUrl: rails.url, scope: 'private', writeEnv: envPath, json: true });
    expect(code).toBe(0);
    const contents = await fs.readFile(envPath, 'utf8');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_ENVPUBTOKEN12345678901');
    expect(contents).toContain('COOLHAND_PRIVATE_KEY=ch_priv_ENVPRIVTOKEN1234567890');
  });

  test('after login, offers to flush pending records and launches background flush on yes', async () => {
    await savePendingRecord({
      command: 'report-blocker',
      kind: 'feedback',
      payload: { explanation: 'saved while logged out', creator_type: 'agent' },
      savedAt: '2026-06-29T12:00:00.000Z',
    });
    (confirm as jest.Mock).mockResolvedValue(true);

    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_FLUSHYESTOKEN123456789',
      state,
      clientName: 'Flush',
      clientId: 'flush',
    }));
    wireRedirect();

    const code = await runLogin({ baseUrl: rails.url });
    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).toHaveBeenCalled();
  });

  test('after login with pending records but user declines, does not launch flush', async () => {
    await savePendingRecord({
      command: 'report-blocker',
      kind: 'feedback',
      payload: { explanation: 'x', creator_type: 'agent' },
      savedAt: '2026-06-29T12:00:00.000Z',
    });
    (confirm as jest.Mock).mockResolvedValue(false);

    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_FLUSHNOTOKEN1234567890',
      state,
      clientName: 'Flush',
      clientId: 'flushno',
    }));
    wireRedirect();

    const code = await runLogin({ baseUrl: rails.url });
    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  test('after login with no pending records, never prompts', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_NOPENDINGTOKEN1234567',
      state,
      clientName: 'Clean',
      clientId: 'clean',
    }));
    wireRedirect();

    const code = await runLogin({ baseUrl: rails.url });
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(spawnBackgroundFlush).not.toHaveBeenCalled();
  });

  // Use deliverCallback directly to avoid the fake-rails dance.
  test('deliverCallback with valid params succeeds', async () => {
    rails = await startFakeRails(({ state }) => ({
      token: 'ch_pub_DELIVERCALLBACKVALID000',
      state,
      clientName: 'Direct',
      clientId: 'direct',
    }));

    (openBrowser as jest.Mock).mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri')!;
      const state = parsed.searchParams.get('state')!;
      await deliverCallback(redirectUri, {
        token: 'ch_pub_DELIVERCALLBACKVALID000',
        state,
        clientName: 'Direct',
        clientId: 'direct',
      });
    });

    const code = await runLogin({ baseUrl: rails.url, json: true });
    expect(code).toBe(0);
    const cfg = await loadConfig();
    expect(cfg.clients.direct.client_name).toBe('Direct');
  });
});

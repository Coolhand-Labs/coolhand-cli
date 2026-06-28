import { EventEmitter } from 'events';
import { run } from '../../src/commands/claude.js';

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  getClient: jest.fn(),
}));
jest.mock('../../src/proxy/certs.js', () => ({
  getOrCreateCA: jest.fn().mockResolvedValue({ key: 'fake-key', cert: 'fake-cert' }),
  getCertPath: jest.fn().mockReturnValue('/fake/.coolhand/proxy/ca-cert.pem'),
}));
jest.mock('../../src/proxy/proxy.js', () => ({
  startProxy: jest.fn(),
}));
import { loadConfig, getClient } from '../../src/config.js';

type Spawn = typeof import('child_process').spawn;

const ENTRY = {
  client_id: 'c1',
  client_name: 'Acme',
  api_key: 'pubkey123',
  base_url: 'https://coolhandlabs.com',
  saved_at: '2026-01-01T00:00:00Z',
};

function spawnClosingWith(code: number): jest.Mock {
  return jest.fn().mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', code));
    return child;
  });
}

describe('claude command', () => {
  beforeEach(() => {
    (loadConfig as jest.Mock).mockReset().mockResolvedValue({
      version: 1,
      default_client_id: 'c1',
      clients: { c1: ENTRY },
    });
    (getClient as jest.Mock).mockReset().mockReturnValue(ENTRY);
  });

  test('spawns claude directly with proxy env vars', async () => {
    const stopFn = jest.fn().mockResolvedValue(undefined);
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: stopFn });
    const spawnFn = spawnClosingWith(0);

    const code = await run(
      { args: ['--resume', 'foo'] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--resume', 'foo']);
    expect(options.stdio).toBe('inherit');
    expect(options.env.HTTP_PROXY).toBe('http://127.0.0.1:9999');
    expect(options.env.HTTPS_PROXY).toBe('http://127.0.0.1:9999');
    expect(options.env.SSL_CERT_FILE).toBe('/fake/.coolhand/proxy/ca-cert.pem');
    expect(options.env.NODE_EXTRA_CA_CERTS).toBe('/fake/.coolhand/proxy/ca-cert.pem');
    expect(options.env.REQUESTS_CA_BUNDLE).toBe('/fake/.coolhand/proxy/ca-cert.pem');
  });

  test('forwards child exit code', async () => {
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(3);

    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(3);
  });

  test('errors when no client configured', async () => {
    (getClient as jest.Mock).mockReturnValue(undefined);
    const startProxyFn = jest.fn();
    const spawnFn = jest.fn();

    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(1);
    expect(startProxyFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('passes apiEndpoint to startProxyFn for non-default base_url', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...ENTRY, base_url: 'https://staging.coolhandlabs.com' });
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(0);

    await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(startProxyFn).toHaveBeenCalledTimes(1);
    const [, proxyOpts] = startProxyFn.mock.calls[0];
    expect(proxyOpts.apiEndpoint).toBe('https://staging.coolhandlabs.com/api/v2/llm_request_logs');
  });

  test('returns INTERNAL if startProxyFn throws', async () => {
    const startProxyFn = jest.fn().mockRejectedValue(new Error('proxy failed'));
    const spawnFn = jest.fn();

    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(2);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

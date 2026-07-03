import { EventEmitter } from 'events';
import { run } from '../../src/commands/monitor.js';
import { resolveWrapSpawn } from '../../src/proxy/wrap-runner.js';
import { CliError } from '../../src/errors.js';

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  resolveClient: jest.fn(),
}));
jest.mock('../../src/proxy/certs.js', () => ({
  getOrCreateCA: jest.fn().mockResolvedValue({ key: 'fake-key', cert: 'fake-cert' }),
  getCertPath: jest.fn().mockReturnValue('/fake/.coolhand/proxy/ca-cert.pem'),
}));
jest.mock('../../src/proxy/proxy.js', () => ({
  startProxy: jest.fn(),
}));
import { loadConfig, resolveClient } from '../../src/config.js';

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

describe('resolveWrapSpawn', () => {
  test('returns the given command directly on non-windows', () => {
    const result = resolveWrapSpawn('kimi', ['--resume', 'foo'], 'linux');
    expect(result).toEqual({ cmd: 'kimi', spawnArgs: ['--resume', 'foo'] });
  });

  test('returns cmd.exe invocation quoting the given command on win32', () => {
    const result = resolveWrapSpawn('kimi', ['--resume', 'foo'], 'win32');
    expect(result.cmd).toMatch(/cmd\.exe/i);
    expect(result.windowsVerbatimArguments).toBe(true);
    const cmdStr = result.spawnArgs[3];
    expect(cmdStr).toContain('"kimi"');
    expect(cmdStr).toContain('"--resume"');
    expect(cmdStr).toContain('"foo"');
  });
});

describe('monitor command', () => {
  beforeEach(() => {
    (loadConfig as jest.Mock).mockReset().mockResolvedValue({
      version: 1,
      default_client_id: 'c1',
      clients: { c1: ENTRY },
    });
    (resolveClient as jest.Mock).mockReset().mockResolvedValue(ENTRY);
  });

  test('spawns the given command directly with proxy env vars', async () => {
    const stopFn = jest.fn().mockResolvedValue(undefined);
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: stopFn });
    const spawnFn = spawnClosingWith(0);

    const code = await run(
      { command: 'kimi', args: ['--resume', 'foo'] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    expect(cmd).toBe('kimi');
    expect(args).toEqual(['--resume', 'foo']);
    expect(options.stdio).toBe('inherit');
    expect(options.env.HTTP_PROXY).toBe('http://127.0.0.1:9999');
    expect(options.env.HTTPS_PROXY).toBe('http://127.0.0.1:9999');
    expect(options.env.SSL_CERT_FILE).toBe('/fake/.coolhand/proxy/ca-cert.pem');
    expect(options.env.NODE_EXTRA_CA_CERTS).toBe('/fake/.coolhand/proxy/ca-cert.pem');
    expect(options.env.REQUESTS_CA_BUNDLE).toBe('/fake/.coolhand/proxy/ca-cert.pem');
    expect(options.env.COOLHAND_API_KEY).toBe('pubkey123');
    expect(options.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  test('passes a per-command collector label to startProxy', async () => {
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(0);

    await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(startProxyFn).toHaveBeenCalledTimes(1);
    const [, proxyOpts] = startProxyFn.mock.calls[0];
    expect(proxyOpts.collector).toMatch(/\/kimi$/);
  });

  test('forwards child exit code', async () => {
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(3);

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(3);
  });

  test('errors (exit 1) and does not spawn when no client is configured', async () => {
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'No Coolhand account configured.')
    );
    const startProxyFn = jest.fn();
    const spawnFn = jest.fn();

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(1);
    expect(startProxyFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('adds apiEndpoint only for a non-default base_url, with the ingest path', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...ENTRY, base_url: 'https://staging.coolhandlabs.com' });
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(0);

    await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(startProxyFn).toHaveBeenCalledTimes(1);
    const [, proxyOpts] = startProxyFn.mock.calls[0];
    expect(proxyOpts.apiEndpoint).toBe('https://staging.coolhandlabs.com/api/v2/llm_request_logs');
  });

  test('stops proxy and returns INTERNAL on child error event', async () => {
    const stopFn = jest.fn().mockResolvedValue(undefined);
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: stopFn });
    const spawnFn = jest.fn().mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    });

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(2);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  test('errors when client has no public api_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...ENTRY, api_key: undefined });
    const startProxyFn = jest.fn();
    const spawnFn = jest.fn();

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(1);
    expect(startProxyFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('forwards clientId to resolveClient when provided', async () => {
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: jest.fn().mockResolvedValue(undefined) });
    const spawnFn = spawnClosingWith(0);
    await run(
      { command: 'kimi', args: [], clientId: 'acme' },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(resolveClient).toHaveBeenCalledWith(expect.anything(), 'acme');
  });

  test('returns INTERNAL (exit 2) when the proxy cannot be started', async () => {
    const startProxyFn = jest.fn().mockRejectedValue(new Error('proxy failed'));
    const spawnFn = jest.fn();

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(2);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('returns INTERNAL (exit 2) and drains proxy when spawnFn throws synchronously', async () => {
    const stopFn = jest.fn().mockResolvedValue(undefined);
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: stopFn });
    const spawnFn = jest.fn().mockImplementation(() => { throw new Error('ENOENT'); });

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(2);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  test('resolves with child exit code even when proxy.stop() rejects during close', async () => {
    const stopFn = jest.fn().mockRejectedValue(new Error('stop failed'));
    const startProxyFn = jest.fn().mockResolvedValue({ port: 9999, stop: stopFn });
    const spawnFn = spawnClosingWith(42);

    const code = await run(
      { command: 'kimi', args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(42);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});

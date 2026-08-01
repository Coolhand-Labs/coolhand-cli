import { EventEmitter } from 'events';
import { run, resolveSpawn } from '../../src/commands/claude.js';
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

describe('resolveSpawn', () => {
  test('returns claude directly on non-windows', () => {
    const result = resolveSpawn(['--resume', 'foo'], 'linux');
    expect(result).toEqual({ cmd: 'claude', spawnArgs: ['--resume', 'foo'] });
  });

  test('returns cmd.exe invocation on win32', () => {
    const result = resolveSpawn(['--resume', 'foo'], 'win32');
    expect(result.cmd).toMatch(/cmd\.exe/i);
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.spawnArgs[0]).toBe('/d');
    expect(result.spawnArgs[1]).toBe('/s');
    expect(result.spawnArgs[2]).toBe('/c');
    const cmdStr = result.spawnArgs[3];
    expect(cmdStr).toContain('"claude"');
    expect(cmdStr).toContain('"--resume"');
    expect(cmdStr).toContain('"foo"');
  });

  test('doubles trailing backslashes to prevent escaping closing quote', () => {
    const result = resolveSpawn(['C:\\path\\'], 'win32');
    const cmdStr = result.spawnArgs[3];
    // "C:\path\\" — trailing \ doubled, then wrapped in quotes
    expect(cmdStr).toContain('"C:\\path\\\\"');
  });

  test('escapes embedded double quotes as ""', () => {
    const result = resolveSpawn(['say "hello"'], 'win32');
    const cmdStr = result.spawnArgs[3];
    expect(cmdStr).toContain('"say ""hello"""');
  });

  test('escapes percent signs to prevent env-var expansion', () => {
    const result = resolveSpawn(['%PATH%'], 'win32');
    const cmdStr = result.spawnArgs[3];
    expect(cmdStr).toContain('"%%PATH%%"');
  });
});

describe('claude command', () => {
  beforeEach(() => {
    (loadConfig as jest.Mock).mockReset().mockResolvedValue({
      version: 1,
      default_client_id: 'c1',
      clients: { c1: ENTRY },
    });
    (resolveClient as jest.Mock).mockReset().mockResolvedValue(ENTRY);
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
    expect(options.env.COOLHAND_API_KEY).toBe('pubkey123');
    expect(options.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(stopFn).toHaveBeenCalledTimes(1);
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

  test('errors (exit 1) and does not spawn when no client is configured', async () => {
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'No Coolhand account configured.')
    );
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

  test('adds apiEndpoint only for a non-default base_url, with the ingest path', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...ENTRY, base_url: 'https://staging.coolhandlabs.com' });
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

  test('refuses a non-loopback http base_url and does not spawn', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...ENTRY, base_url: 'http://internal-mirror.corp' });
    const startProxyFn = jest.fn();
    const spawnFn = jest.fn();

    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );

    expect(code).not.toBe(0);
    expect(startProxyFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
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
      { args: [] },
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
      { args: [] },
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
      { args: [], clientId: 'acme' },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(resolveClient).toHaveBeenCalledWith(expect.anything(), 'acme');
  });

  test('returns INTERNAL (exit 2) when the proxy cannot be started', async () => {
    const startProxyFn = jest.fn().mockRejectedValue(new Error('proxy failed'));
    const spawnFn = jest.fn();

    const code = await run(
      { args: [] },
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
      { args: [] },
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
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, startProxyFn }
    );
    expect(code).toBe(42);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});

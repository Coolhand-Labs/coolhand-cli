import { EventEmitter } from 'events';
import { run } from '../../src/commands/claude.js';

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  getClient: jest.fn(),
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

// A fake spawn whose child emits `close` (with the given code) on the next tick,
// so the awaited run() resolves without launching a real process.
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

  test('spawns the proxy wrap with claude + forwarded args and the stored key', async () => {
    const spawnFn = spawnClosingWith(0);
    const code = await run(
      { args: ['--resume', 'foo'] },
      { spawnFn: spawnFn as unknown as Spawn, resolveProxyCli: () => '/fake/coolhand-proxy/dist/cli.js' }
    );

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/fake/coolhand-proxy/dist/cli.js', 'wrap', '--silent', '--', 'claude', '--resume', 'foo']);
    expect(options.stdio).toBe('inherit');
    expect(options.env.COOLHAND_API_KEY).toBe('pubkey123');
  });

  test('forwards the child exit code', async () => {
    const spawnFn = spawnClosingWith(3);
    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, resolveProxyCli: () => '/fake/cli.js' }
    );
    expect(code).toBe(3);
  });

  test('errors (exit 1) and does not spawn when no client is configured', async () => {
    (getClient as jest.Mock).mockReturnValue(undefined);
    const spawnFn = jest.fn();
    const code = await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, resolveProxyCli: () => '/fake/cli.js' }
    );
    expect(code).toBe(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('adds --api-endpoint only for a non-default base_url, with the ingest path', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...ENTRY, base_url: 'https://staging.coolhandlabs.com' });
    const spawnFn = spawnClosingWith(0);
    await run(
      { args: [] },
      { spawnFn: spawnFn as unknown as Spawn, resolveProxyCli: () => '/fake/cli.js' }
    );
    const [, args] = spawnFn.mock.calls[0];
    expect(args).toEqual([
      '/fake/cli.js',
      'wrap',
      '--silent',
      '--api-endpoint',
      'https://staging.coolhandlabs.com/api/v2/llm_request_logs',
      '--',
      'claude',
    ]);
  });

  test('returns INTERNAL (exit 2) when the proxy cannot be resolved', async () => {
    const spawnFn = jest.fn();
    const code = await run(
      { args: [] },
      {
        spawnFn: spawnFn as unknown as Spawn,
        resolveProxyCli: () => {
          throw new Error('not found');
        },
      }
    );
    expect(code).toBe(2);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

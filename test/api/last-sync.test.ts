import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { fetchLastSync } from '../../src/api/last-sync.js';
import { upsertClient } from '../../src/config.js';

interface FakeServer {
  url: string;
  requests: Array<{ path: string; apiKey: string | undefined }>;
  close(): Promise<void>;
}

async function startServer(handler: (path: string) => { status: number; body: string }): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      path: `${reqUrl.pathname}?${reqUrl.searchParams.toString()}`,
      apiKey: req.headers['x-api-key'] as string | undefined,
    });
    const { status, body } = handler(reqUrl.pathname);
    res.statusCode = status;
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('fetchLastSync', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `chs-lastsync-${randomBytes(6).toString('hex')}`);
    prev = process.env.COOLHAND_CONFIG_DIR;
    process.env.COOLHAND_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (prev === undefined) {
      delete process.env.COOLHAND_CONFIG_DIR;
    } else {
      process.env.COOLHAND_CONFIG_DIR = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function configureClient(baseUrl: string): Promise<void> {
    await upsertClient({
      client_id: 'c1',
      client_name: 'Test',
      api_key: 'pub-key-123',
      private_key: 'priv-key-456',
      base_url: baseUrl,
      saved_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    });
  }

  test('returns the Date from a 200 response', async () => {
    const server = await startServer(() => ({
      status: 200,
      body: JSON.stringify([
        {
          id: 42,
          collector: 'coolhand-cli-0.7.0/claude-code',
          source_api: 'claude_code',
          created_at: '2026-06-10T14:23:00Z',
          updated_at: '2026-06-10T14:23:00Z',
        },
      ]),
    }));
    try {
      await configureClient(server.url);
      const result = await fetchLastSync();
      expect(result?.toISOString()).toBe('2026-06-10T14:23:00.000Z');
      // Newest claude_code row only; the sort is explicit because the server has no default order.
      expect(server.requests[0].path).toBe(
        '/api/v2/llm_request_logs?q%5Bsource_api_in%5D%5B%5D=claude_code&q%5Bs%5D=created_at+desc&per=1'
      );
      expect(server.requests[0].apiKey).toBe('priv-key-456');
    } finally {
      await server.close();
    }
  });

  test('returns null when the newest row has no usable created_at', async () => {
    const server = await startServer(() => ({ status: 200, body: JSON.stringify([{ id: 42 }]) }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null on an empty result set (no logs on the server yet)', async () => {
    const server = await startServer(() => ({ status: 200, body: '[]' }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null when the array contains a null element', async () => {
    const server = await startServer(() => ({ status: 200, body: '[null]' }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null when the body is a JSON object instead of an array', async () => {
    const server = await startServer(() => ({ status: 200, body: '{}' }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null on a non-2xx response (e.g. 401 when the key lacks read access)', async () => {
    const server = await startServer(() => ({ status: 401, body: JSON.stringify({ error: 'Invalid API key' }) }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null on a non-JSON body', async () => {
    const server = await startServer(() => ({ status: 200, body: 'definitely not json' }));
    try {
      await configureClient(server.url);
      expect(await fetchLastSync()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('returns null (never throws) on a network failure', async () => {
    // Start then immediately close so the port is dead.
    const server = await startServer(() => ({ status: 200, body: '{}' }));
    const deadUrl = server.url;
    await server.close();
    await configureClient(deadUrl);
    await expect(fetchLastSync()).resolves.toBeNull();
  });

  test('returns null when no private key is configured', async () => {
    // No client configured and no COOLHAND_PRIVATE_KEY env → nothing to authenticate with.
    const prevKey = process.env.COOLHAND_PRIVATE_KEY;
    delete process.env.COOLHAND_PRIVATE_KEY;
    try {
      expect(await fetchLastSync()).toBeNull();
    } finally {
      if (prevKey !== undefined) {
        process.env.COOLHAND_PRIVATE_KEY = prevKey;
      }
    }
  });

  test('returns null for a non-http base url', async () => {
    await configureClient('file:///etc/passwd');
    expect(await fetchLastSync()).toBeNull();
  });

  test('returns null for an http base url on a non-loopback host', async () => {
    await configureClient('http://internal-mirror.corp');
    expect(await fetchLastSync()).toBeNull();
  });
});

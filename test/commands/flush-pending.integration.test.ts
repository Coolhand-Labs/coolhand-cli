import http from 'http';
import { AddressInfo } from 'net';
import { flushPending } from '../../src/commands/flush-pending.js';
import { upsertClient } from '../../src/config.js';
import {
  savePendingRecord,
  countPending,
  flushFailed,
  type PendingRecord,
} from '../../src/pending-store.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

/**
 * Real upload proof: no SDK mock. We stand up a local HTTP server, point a configured
 * client at it, and assert that flushPending actually POSTs the saved feedback over the
 * wire, then deletes the file on success and keeps it on a server error. This is the
 * reproducible, CI-runnable evidence for the upload-on-login flow.
 */

const FEEDBACK_PATH = '/api/v2/llm_request_log_feedbacks';

interface FakeServer {
  url: string;
  received: Array<{ apiKey: string | undefined; body: unknown }>;
  close(): Promise<void>;
}

async function startFakeCoolhand(status = 200): Promise<FakeServer> {
  const received: Array<{ apiKey: string | undefined; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === FEEDBACK_PATH) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ apiKey: req.headers['x-api-key'] as string | undefined, body: JSON.parse(body) });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status < 300 ? { id: 1, llm_request_log_id: 1 } : { error: 'boom' }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeRecord(): PendingRecord {
  return {
    command: 'report-blocker',
    kind: 'feedback',
    payload: { explanation: 'no internet', creator_type: 'agent', creator_unique_id: 'agent-1' },
    savedAt: '2026-06-29T12:00:00.000Z',
  };
}

async function configureClient(baseUrl: string): Promise<void> {
  await upsertClient(
    {
      client_id: 'acme',
      client_name: 'Acme',
      api_key: 'pub_key_123',
      base_url: baseUrl,
      saved_at: 'now',
    },
    true
  );
}

describe('flush-pending (real HTTP upload)', () => {
  let home: TmpHome;
  let server: FakeServer;

  beforeEach(async () => {
    home = await createTmpHome();
  });

  afterEach(async () => {
    await server?.close();
    await home.cleanup();
  });

  test('really POSTs the saved feedback, then deletes the file on a confirmed upload', async () => {
    server = await startFakeCoolhand(200);
    await configureClient(server.url);
    await savePendingRecord(makeRecord());

    const result = await flushPending();

    expect(result).toEqual({ uploaded: 1, failed: 0 });
    expect(await countPending()).toBe(0); // file removed after success
    expect(await flushFailed()).toBe(false);

    // The request actually went over the wire with the right key and payload.
    expect(server.received).toHaveLength(1);
    expect(server.received[0].apiKey).toBe('pub_key_123');
    const sent = server.received[0].body as { llm_request_log_feedback: { explanation: string } };
    expect(sent.llm_request_log_feedback.explanation).toBe('no internet');
  });

  test('keeps the file and flags a failure when the server rejects the upload', async () => {
    server = await startFakeCoolhand(500);
    await configureClient(server.url);
    await savePendingRecord(makeRecord());

    const result = await flushPending();

    expect(result).toEqual({ uploaded: 0, failed: 1 });
    expect(await countPending()).toBe(1); // file kept for retry
    expect(await flushFailed()).toBe(true);
    expect(server.received).toHaveLength(1); // it really tried
  });
});

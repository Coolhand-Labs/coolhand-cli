jest.mock('mockttp', () => ({ getLocal: jest.fn() }));
jest.mock('../../src/proxy/interceptor.js', () => ({
  shouldCapture: jest.fn().mockReturnValue(false),
  sanitizeHeaders: jest.fn((h: Record<string, string>) => h),
  sanitizeURL: jest.fn((u: string) => u),
  flattenHeaders: jest.fn((h: unknown) => h),
}));
jest.mock('../../src/proxy/sender.js', () => ({
  sendToCoolhand: jest.fn().mockResolvedValue(undefined),
}));

import * as mockttp from 'mockttp';
import { startProxy } from '../../src/proxy/proxy.js';
import { shouldCapture, sanitizeURL } from '../../src/proxy/interceptor.js';
import { sendToCoolhand } from '../../src/proxy/sender.js';

const CA = { key: 'fake-key', cert: 'fake-cert' };

type Handler = (arg: unknown) => void;
let registeredHandlers: Record<string, Handler>;
let mockStop: jest.Mock;

beforeEach(() => {
  registeredHandlers = {};
  mockStop = jest.fn().mockResolvedValue(undefined);
  const mockServer = {
    on: jest.fn().mockImplementation((event: string, handler: Handler) => {
      registeredHandlers[event] = handler;
      return Promise.resolve();
    }),
    forAnyRequest: jest.fn().mockReturnValue({
      thenPassThrough: jest.fn().mockResolvedValue(undefined),
    }),
    start: jest.fn().mockResolvedValue(undefined),
    stop: mockStop,
    port: 54321,
  };
  (mockttp.getLocal as jest.Mock).mockReturnValue(mockServer);
  (shouldCapture as jest.Mock).mockReturnValue(false);
  (sanitizeURL as jest.Mock).mockImplementation((u: string) => u);
  (sendToCoolhand as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

// Flush all pending microtasks and macrotasks through multiple setImmediate
// rounds so async promise chains complete before assertions run.
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeReq(id: string, url = 'https://api.anthropic.com/v1/messages', body = '{"model":"claude-opus-4-8"}') {
  return {
    id,
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: { getText: jest.fn().mockResolvedValue(body) },
    timingEvents: { startTimestamp: 1000 },
  };
}

function makeRes(id: string, statusCode = 200, body = '{"id":"msg_123"}') {
  return {
    id,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: { getText: jest.fn().mockResolvedValue(body) },
    timingEvents: { responseSentTimestamp: 2000 },
  };
}

describe('startProxy', () => {
  test('starts the server and returns the bound port', async () => {
    const proxy = await startProxy(CA, { apiKey: 'key', silent: true });
    expect(proxy.port).toBe(54321);
    expect(proxy.stop).toBeInstanceOf(Function);
  });

  test('registers request, abort, and response handlers', async () => {
    await startProxy(CA, { apiKey: 'key', silent: true });
    expect(registeredHandlers.request).toBeDefined();
    expect(registeredHandlers.abort).toBeDefined();
    expect(registeredHandlers.response).toBeDefined();
  });

  test('stop() calls server.stop()', async () => {
    const proxy = await startProxy(CA, { apiKey: 'key', silent: true });
    await proxy.stop();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test('non-captured requests are ignored — response does not trigger sendToCoolhand', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(false);
    await startProxy(CA, { apiKey: 'key', silent: true });

    registeredHandlers.request(makeReq('r1'));
    registeredHandlers.response(makeRes('r1'));

    await flush();

    expect(sendToCoolhand).not.toHaveBeenCalled();
  });

  test('captured request paired with response triggers sendToCoolhand', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);
    await startProxy(CA, { apiKey: 'key', silent: true });

    registeredHandlers.request(makeReq('r2'));
    registeredHandlers.response(makeRes('r2'));

    await flush();

    expect(sendToCoolhand).toHaveBeenCalledTimes(1);
    const [interaction] = (sendToCoolhand as jest.Mock).mock.calls[0];
    expect(interaction.request.method).toBe('POST');
    expect(interaction.request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(interaction.response.statusCode).toBe(200);
  });

  test('abort removes the pending request — late response is silently dropped', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);
    await startProxy(CA, { apiKey: 'key', silent: true });

    registeredHandlers.request(makeReq('r3'));
    registeredHandlers.abort({ id: 'r3' });
    registeredHandlers.response(makeRes('r3'));

    await flush();

    expect(sendToCoolhand).not.toHaveBeenCalled();
  });

  test('stop() drains in-flight sends before resolving', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);

    let resolveSend!: () => void;
    (sendToCoolhand as jest.Mock).mockImplementation(
      () => new Promise<void>(r => { resolveSend = r; })
    );

    const proxy = await startProxy(CA, { apiKey: 'key', silent: true });

    registeredHandlers.request(makeReq('r4'));
    registeredHandlers.response(makeRes('r4'));

    // Allow the async chain to reach sendToCoolhand (which is now hanging)
    await flush();

    let stopped = false;
    const stopPromise = proxy.stop().then(() => { stopped = true; });

    // One setImmediate round lets server.stop() resolve and stop() enter the
    // drain loop — where it blocks on inFlightSends rather than a wall-clock delay.
    await flush(1);
    expect(stopped).toBe(false);

    // Unblock the send — stop() should now complete
    resolveSend();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  test('request handler silently skips capture when shouldCapture throws', async () => {
    (shouldCapture as jest.Mock).mockImplementation(() => { throw new Error('service init failed'); });
    await startProxy(CA, { apiKey: 'key', silent: true });

    // Handler must not throw — the try/catch degrades gracefully
    expect(() => registeredHandlers.request(makeReq('r5'))).not.toThrow();

    // No pending request stored, so response is silently dropped
    registeredHandlers.response(makeRes('r5'));
    await flush();
    expect(sendToCoolhand).not.toHaveBeenCalled();
  });

  test('passes a custom collector option through to sendToCoolhand', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);
    await startProxy(CA, { apiKey: 'key', silent: true, collector: 'coolhand-cli-0.7.0/kimi' });

    registeredHandlers.request(makeReq('r6'));
    registeredHandlers.response(makeRes('r6'));

    await flush();

    expect(sendToCoolhand).toHaveBeenCalledTimes(1);
    const [, sendOpts] = (sendToCoolhand as jest.Mock).mock.calls[0];
    expect(sendOpts.collector).toBe('coolhand-cli-0.7.0/kimi');
  });

  test('captured interaction uses the sanitizeURL return value, not the raw request URL', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);
    (sanitizeURL as jest.Mock).mockImplementation(
      (u: string) => u.replace(/key=[^&]+/, 'key=[REDACTED]')
    );
    await startProxy(CA, { apiKey: 'key', silent: true });

    registeredHandlers.request(makeReq('r7', 'https://generativelanguage.googleapis.com/v1/models?key=super-secret'));
    registeredHandlers.response(makeRes('r7'));

    await flush();

    expect(sanitizeURL).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1/models?key=super-secret');
    const [interaction] = (sendToCoolhand as jest.Mock).mock.calls[0];
    expect(interaction.request.url).toBe('https://generativelanguage.googleapis.com/v1/models?key=[REDACTED]');
  });

  test('redacts secrets found in the request and response bodies before sending', async () => {
    (shouldCapture as jest.Mock).mockReturnValue(true);
    await startProxy(CA, { apiKey: 'key', silent: true });

    const stripeKey = `sk_live_${'a'.repeat(24)}`;
    const reqBody = `{"tool_result":"AWS key: AKIAIOSFODNN7EXAMPLE, keep going"}`;
    const resBody = `{"content":"Stripe key: ${stripeKey}, noted"}`;

    registeredHandlers.request(makeReq('r8', 'https://api.anthropic.com/v1/messages', reqBody));
    registeredHandlers.response(makeRes('r8', 200, resBody));

    await flush();

    const [interaction] = (sendToCoolhand as jest.Mock).mock.calls[0];
    expect(interaction.request.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(interaction.response.body).not.toContain(stripeKey);
    expect(interaction.request.body).toContain('keep going');
    expect(interaction.response.body).toContain('noted');
  });

  test('response for unknown request id is silently ignored', async () => {
    await startProxy(CA, { apiKey: 'key', silent: true });

    // No matching request was registered
    registeredHandlers.response(makeRes('unknown-id'));

    await flush();

    expect(sendToCoolhand).not.toHaveBeenCalled();
  });
});

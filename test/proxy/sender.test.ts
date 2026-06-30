import { sendToCoolhand, resetCallIdForTesting, type CapturedInteraction } from '../../src/proxy/sender.js';

const INTERACTION: CapturedInteraction = {
  request: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"claude-3"}',
  },
  response: {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"id":"msg_1"}',
  },
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('sendToCoolhand', () => {
  beforeEach(() => {
    resetCallIdForTesting();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }) as Response
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('POSTs to the default endpoint with correct auth header', async () => {
    await sendToCoolhand(INTERACTION, { apiKey: 'test-key', silent: true });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://coolhandlabs.com/api/v2/llm_request_logs');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('uses a custom apiEndpoint when provided', async () => {
    await sendToCoolhand(INTERACTION, { apiKey: 'k', apiEndpoint: 'https://staging.example.com/api/v2/llm_request_logs', silent: true });

    const [url] = (fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://staging.example.com/api/v2/llm_request_logs');
  });

  test('includes the correct payload shape', async () => {
    await sendToCoolhand(INTERACTION, { apiKey: 'k', silent: true });

    const [, init] = (fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.llm_request_log.raw_request.method).toBe('POST');
    expect(body.llm_request_log.raw_request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.llm_request_log.raw_request.status_code).toBe(200);
    expect(body.llm_request_log.raw_request.protocol).toBe('https');
    expect(typeof body.llm_request_log.raw_request.id).toBe('number');
    expect(body.llm_request_log.raw_request.id).toBeGreaterThan(0);
  });

  test('increments id on each call', async () => {
    await sendToCoolhand(INTERACTION, { apiKey: 'k', silent: true });
    await sendToCoolhand(INTERACTION, { apiKey: 'k', silent: true });

    const id1 = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body).llm_request_log.raw_request.id;
    const id2 = JSON.parse((fetch as jest.Mock).mock.calls[1][1].body).llm_request_log.raw_request.id;
    expect(id2).toBe(id1 + 1);
  });

  test('does not throw on non-ok response when silent', async () => {
    (fetch as jest.Mock).mockResolvedValue(new Response('Bad request', { status: 400 }));
    await expect(sendToCoolhand(INTERACTION, { apiKey: 'k', silent: true })).resolves.toBeUndefined();
  });

  test('does not throw on network error when silent', async () => {
    (fetch as jest.Mock).mockRejectedValue(new Error('network failure'));
    await expect(sendToCoolhand(INTERACTION, { apiKey: 'k', silent: true })).resolves.toBeUndefined();
  });

});

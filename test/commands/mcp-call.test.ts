import { mcpCall } from '../../src/commands/mcp-call.js';

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  getClient: jest.fn(),
}));
import { loadConfig, getClient } from '../../src/config.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const fakeClient = {
  id: 'client-1',
  public_key: 'pub_key',
  private_key: 'priv_key_abc',
  base_url: undefined as string | undefined,
  default: true,
};

const okResponse = (result: unknown) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
});

describe('mcpCall', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.COOLHAND_PRIVATE_KEY;
    (loadConfig as jest.Mock).mockResolvedValue({});
    (getClient as jest.Mock).mockReturnValue(fakeClient);
    mockFetch.mockResolvedValue(okResponse({ ok: true }));
  });

  test('returns result on success', async () => {
    const result = await mcpCall('test_tool', { foo: 'bar' });
    expect(result).toEqual({ ok: true });
  });

  test('sends correct JSON-RPC request shape', async () => {
    await mcpCall('my_tool', { x: 1 });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'my_tool', arguments: { x: 1 } },
    });
  });

  test('sends X-API-Key and Content-Type headers', async () => {
    await mcpCall('tool', {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('priv_key_abc');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('uses COOLHAND_PRIVATE_KEY env when no client configured', async () => {
    (getClient as jest.Mock).mockReturnValue(null);
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    await mcpCall('tool', {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('env_priv_key');
  });

  test('uses specified clientId client private_key', async () => {
    const otherClient = { ...fakeClient, id: 'other', private_key: 'other_key' };
    (getClient as jest.Mock).mockReturnValue(otherClient);
    await mcpCall('tool', {}, { clientId: 'other' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('other_key');
  });

  test('throws CLIENT_NOT_FOUND when clientId given but client missing', async () => {
    (getClient as jest.Mock).mockReturnValue(null);
    await expect(mcpCall('tool', {}, { clientId: 'missing' })).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  test('throws NOT_CONFIGURED when no client and no env var', async () => {
    (getClient as jest.Mock).mockReturnValue(null);
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  test('throws NO_PRIVATE_KEY when client has no private_key', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...fakeClient, private_key: undefined });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'NO_PRIVATE_KEY',
    });
  });

  test('uses client base_url for request URL', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...fakeClient, base_url: 'https://custom.example.com' });
    await mcpCall('tool', {});
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://custom.example.com/mcp');
  });

  test('throws INVALID_BASE_URL for malformed base_url', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...fakeClient, base_url: 'not a url' });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });

  test('throws INVALID_BASE_URL for non-http protocol', async () => {
    (getClient as jest.Mock).mockReturnValue({ ...fakeClient, base_url: 'ftp://example.com' });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });

  test('throws MCP_ERROR when fetch throws a network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
    });
  });

  test('throws MCP_ERROR on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
    });
  });

  test('throws MCP_ERROR when response body is not valid JSON', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('not json') });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
    });
  });

  test('throws MCP_ERROR when JSON-RPC response has error field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'tool failed' } })),
    });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
    });
  });
});

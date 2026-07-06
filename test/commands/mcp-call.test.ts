import { mcpCall } from '../../src/commands/mcp-call.js';
import { CliError } from '../../src/errors.js';

jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  resolveClient: jest.fn(),
}));
import { loadConfig, resolveClient } from '../../src/config.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const fakeClient = {
  client_id: 'client-1',
  client_name: 'Test Client',
  api_key: 'pub_key',
  private_key: 'priv_key_abc',
  base_url: 'https://coolhandlabs.com',
  saved_at: new Date().toISOString(),
};

const cfgWithClient = {
  version: 1 as const,
  default_client_id: 'client-1',
  clients: { 'client-1': fakeClient },
};

const cfgEmpty = {
  version: 1 as const,
  default_client_id: null,
  clients: {},
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
    delete process.env.COOLHAND_CLIENT_ID;
    (loadConfig as jest.Mock).mockResolvedValue(cfgWithClient);
    (resolveClient as jest.Mock).mockResolvedValue(fakeClient);
    mockFetch.mockResolvedValue(okResponse({ ok: true }));
  });

  afterEach(() => {
    delete process.env.COOLHAND_PRIVATE_KEY;
    delete process.env.COOLHAND_CLIENT_ID;
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

  test('uses COOLHAND_PRIVATE_KEY env when no clients configured', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgEmpty);
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'Not logged in.')
    );
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    await mcpCall('tool', {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('env_priv_key');
  });

  test('uses specified clientId client private_key', async () => {
    const otherClient = { ...fakeClient, client_id: 'other', private_key: 'other_key' };
    (resolveClient as jest.Mock).mockResolvedValue(otherClient);
    await mcpCall('tool', {}, { clientId: 'other' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('other_key');
  });

  test('throws CLIENT_NOT_FOUND when clientId given but client missing', async () => {
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('CLIENT_NOT_FOUND', 'No client "missing" is configured.')
    );
    await expect(mcpCall('tool', {}, { clientId: 'missing' })).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  test('throws CLIENT_NOT_FOUND when explicit clientId given on empty config even with COOLHAND_PRIVATE_KEY', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgEmpty);
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('CLIENT_NOT_FOUND', 'No client "explicit" is configured.')
    );
    // An explicit --client-id should never silently fall back to COOLHAND_PRIVATE_KEY.
    await expect(mcpCall('tool', {}, { clientId: 'explicit' })).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  test('throws CLIENT_NOT_FOUND when COOLHAND_CLIENT_ID env var is set to unknown client on empty config', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgEmpty);
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    process.env.COOLHAND_CLIENT_ID = 'nonexistent';
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('CLIENT_NOT_FOUND', 'COOLHAND_CLIENT_ID="nonexistent" does not match any configured client.')
    );
    // COOLHAND_CLIENT_ID is an intentional selection — should not silently fall through.
    await expect(mcpCall('tool', {})).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('throws NOT_CONFIGURED when no clients and no env var', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgEmpty);
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'Not logged in.')
    );
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  test('throws NO_PRIVATE_KEY when resolved client has no private_key even if COOLHAND_PRIVATE_KEY is set', async () => {
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'NO_PRIVATE_KEY',
    });
  });

  test('propagates NOT_CONFIGURED when hasStoredClients but resolveClient throws NOT_CONFIGURED with no env var', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgWithClient); // hasStoredClients = true
    delete process.env.COOLHAND_PRIVATE_KEY;
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'Multiple clients configured but no default is set.')
    );
    await expect(mcpCall('tool', {})).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  test('propagates CLIENT_NOT_FOUND when resolveClient throws for bad COOLHAND_CLIENT_ID in hasStoredClients branch', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgWithClient); // hasStoredClients = true
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('CLIENT_NOT_FOUND', 'COOLHAND_CLIENT_ID="nope" does not match any configured client.')
    );
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  test('propagates NOT_CONFIGURED when stored clients exist but resolveClient throws NOT_CONFIGURED (even with COOLHAND_PRIVATE_KEY set)', async () => {
    (loadConfig as jest.Mock).mockResolvedValue(cfgWithClient); // hasStoredClients = true
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    (resolveClient as jest.Mock).mockRejectedValue(
      new CliError('NOT_CONFIGURED', 'Multiple clients configured but no default is set.')
    );
    await expect(mcpCall('tool', {})).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(resolveClient).toHaveBeenCalled(); // confirms resolveClient ran before the catch fallback
  });

  test('throws NO_PRIVATE_KEY when client has no private_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'NO_PRIVATE_KEY',
    });
  });

  test('throws NO_PRIVATE_KEY when explicit clientId client has no private_key even if COOLHAND_PRIVATE_KEY is set', async () => {
    process.env.COOLHAND_PRIVATE_KEY = 'env_priv_key';
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(mcpCall('tool', {}, { clientId: 'client-1' })).rejects.toMatchObject({
      code: 'NO_PRIVATE_KEY',
    });
  });

  test('uses client base_url for request URL', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, base_url: 'https://custom.example.com' });
    await mcpCall('tool', {});
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://custom.example.com/mcp');
  });

  test('throws INVALID_BASE_URL for malformed base_url', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, base_url: 'not a url' });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });

  test('throws INVALID_BASE_URL for non-http protocol', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, base_url: 'ftp://example.com' });
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
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
    });
  });

  test('401 response includes a re-authenticate hint', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') });
    await expect(mcpCall('tool', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
      message: expect.stringContaining("coolhand login --scope private"),
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

  test('throws MCP_ERROR with the message when result.error is a string (tool-execution failure)', async () => {
    mockFetch.mockResolvedValue(okResponse({ error: 'Cannot rename system workloads' }));
    await expect(mcpCall('update_workload', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
      message: 'Cannot rename system workloads',
    });
  });

  test('throws MCP_ERROR with the message when result.error is a string (not found)', async () => {
    mockFetch.mockResolvedValue(okResponse({ error: 'Workload not found' }));
    await expect(mcpCall('get_workload', {})).rejects.toMatchObject({
      code: 'MCP_ERROR',
      message: 'Workload not found',
    });
  });

  test('does not treat a normal object result as an error when error is absent', async () => {
    const result = await mcpCall('get_workload', {});
    expect(result).toEqual({ ok: true });
  });

  test('does not misinterpret a plain array result as a tool error', async () => {
    mockFetch.mockResolvedValue(okResponse([{ id: '1' }, { id: '2' }]));
    const result = await mcpCall('list_workloads', {});
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  test('passes through a workload result that has no error field unaffected', async () => {
    mockFetch.mockResolvedValue(okResponse({ workload: { id: 'wl-1', name: 'Renamed' } }));
    const result = await mcpCall('update_workload', {});
    expect(result).toEqual({ workload: { id: 'wl-1', name: 'Renamed' } });
  });
});

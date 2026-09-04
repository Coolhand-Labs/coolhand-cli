// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting rule).
const mockCoolhandCtor = jest.fn();

class MockHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

jest.mock('coolhand-node', () => ({
  Coolhand: mockCoolhandCtor,
  HttpError: MockHttpError,
}));
jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  resolveClient: jest.fn(),
}));

import { getTemplateClient, mapTemplateHttpError } from '../../src/api/template-client.js';
import { loadConfig, resolveClient } from '../../src/config.js';
import { HttpError } from 'coolhand-node';

const fakeClient = {
  client_id: 'client-1',
  client_name: 'Test Client',
  api_key: 'pub_key',
  private_key: 'priv_key_abc',
  base_url: 'https://coolhandlabs.com',
  saved_at: new Date().toISOString(),
};

describe('getTemplateClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({});
    (resolveClient as jest.Mock).mockResolvedValue(fakeClient);
    mockCoolhandCtor.mockImplementation((opts) => ({ __opts: opts }));
  });

  test('constructs Coolhand with the client private_key (not api_key) and base_url', async () => {
    await getTemplateClient();
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'priv_key_abc', baseUrl: 'https://coolhandlabs.com' })
    );
  });

  test('passes clientId through to resolveClient', async () => {
    await getTemplateClient({ clientId: 'acme' });
    expect(resolveClient).toHaveBeenCalledWith({}, 'acme');
  });

  test('throws NO_PRIVATE_KEY when the resolved client has no private_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(getTemplateClient()).rejects.toMatchObject({ code: 'NO_PRIVATE_KEY' });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('propagates a CliError thrown by resolveClient (e.g. CLIENT_NOT_FOUND)', async () => {
    const { CliError } = await import('../../src/errors.js');
    (resolveClient as jest.Mock).mockRejectedValue(new CliError('CLIENT_NOT_FOUND', 'No client "x".'));
    await expect(getTemplateClient({ clientId: 'x' })).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base_url', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getTemplateClient()).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });
});

describe('mapTemplateHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapTemplateHttpError(new HttpError('Unauthorized', 401), 'not found', 'narrow it');
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapTemplateHttpError(new HttpError('Not Found', 404), 'Template "abc" not found.', 'narrow it');
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.message).toBe('Template "abc" not found.');
  });

  test('maps a 504 to the log_count timeout explanation plus the caller-supplied hint', () => {
    const err = mapTemplateHttpError(
      new HttpError('Gateway Timeout', 504),
      'not found',
      'Narrow it with --workload-id, --search, or a smaller --per-page, then retry.'
    );
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.message).toContain('log_count');
    expect(err.message).toContain('--workload-id');
    expect(err.message).toContain('--per-page');
  });

  test('does not fold a 504 into the generic server-error message', () => {
    const err = mapTemplateHttpError(new HttpError('Gateway Timeout', 504), 'not found', 'retry');
    expect(err.message).not.toContain('Template request failed');
  });

  test('passes any other HttpError message through, keeping the SDK status prefix', () => {
    // coolhand-node's HttpError message is already `Template request failed (<status>): <body>`.
    const err = mapTemplateHttpError(
      new HttpError('Template request failed (422): {"errors":{"workload_id":["Workload not found"]}}', 422),
      'not found',
      'narrow it'
    );
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.message).toBe('Template request failed (422): {"errors":{"workload_id":["Workload not found"]}}');
  });

  test('does not repeat the status prefix the SDK already added', () => {
    const err = mapTemplateHttpError(
      new HttpError('Template request failed (500): boom', 500),
      'not found',
      'narrow it'
    );
    expect(err.message.match(/Template request failed/g)).toHaveLength(1);
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapTemplateHttpError(new Error('fetch failed'), 'not found', 'narrow it');
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

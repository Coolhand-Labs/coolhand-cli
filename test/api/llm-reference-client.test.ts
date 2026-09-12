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

import { getLlmReferenceClient, mapLlmReferenceHttpError } from '../../src/api/llm-reference-client.js';
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

describe('getLlmReferenceClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({});
    (resolveClient as jest.Mock).mockResolvedValue(fakeClient);
    mockCoolhandCtor.mockImplementation((opts) => ({ __opts: opts }));
  });

  test('constructs Coolhand with the client private_key (not api_key) and base_url', async () => {
    await getLlmReferenceClient();
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'priv_key_abc', baseUrl: 'https://coolhandlabs.com' })
    );
  });

  test('passes clientId through to resolveClient', async () => {
    await getLlmReferenceClient({ clientId: 'acme' });
    expect(resolveClient).toHaveBeenCalledWith({}, 'acme');
  });

  test('throws NO_PRIVATE_KEY when the resolved client has no private_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(getLlmReferenceClient()).rejects.toMatchObject({ code: 'NO_PRIVATE_KEY' });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('propagates a CliError thrown by resolveClient (e.g. CLIENT_NOT_FOUND)', async () => {
    const { CliError } = await import('../../src/errors.js');
    (resolveClient as jest.Mock).mockRejectedValue(new CliError('CLIENT_NOT_FOUND', 'No client "x".'));
    await expect(getLlmReferenceClient({ clientId: 'x' })).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base_url', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getLlmReferenceClient()).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });
});

describe('mapLlmReferenceHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapLlmReferenceHttpError(new HttpError('Unauthorized', 401));
    expect(err.code).toBe('LLM_REFERENCE_ERROR');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 504 to a retryable, narrow-your-filters message', () => {
    const err = mapLlmReferenceHttpError(new HttpError('Gateway Timeout', 504));
    expect(err.code).toBe('LLM_REFERENCE_ERROR');
    expect(err.message).toContain('504');
    expect(err.message).toContain('--file-path-contains');
    expect(err.message).toContain('--per-page');
  });

  test('maps a 422 to a generic message including the server-supplied text', () => {
    const err = mapLlmReferenceHttpError(new HttpError('Unknown filter: id_eq', 422));
    expect(err.code).toBe('LLM_REFERENCE_ERROR');
    expect(err.message).toContain('422');
    expect(err.message).toContain('Unknown filter: id_eq');
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapLlmReferenceHttpError(new Error('fetch failed'));
    expect(err.code).toBe('LLM_REFERENCE_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

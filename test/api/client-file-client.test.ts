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

import { getClientFileClient, mapClientFileHttpError } from '../../src/api/client-file-client.js';
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

describe('getClientFileClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({});
    (resolveClient as jest.Mock).mockResolvedValue(fakeClient);
    mockCoolhandCtor.mockImplementation((opts) => ({ __opts: opts }));
  });

  test('constructs Coolhand with the client private_key (not api_key) and base_url', async () => {
    await getClientFileClient();
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'priv_key_abc', baseUrl: 'https://coolhandlabs.com' })
    );
  });

  test('passes clientId through to resolveClient', async () => {
    await getClientFileClient({ clientId: 'acme' });
    expect(resolveClient).toHaveBeenCalledWith({}, 'acme');
  });

  test('throws NO_PRIVATE_KEY when the resolved client has no private_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(getClientFileClient()).rejects.toMatchObject({ code: 'NO_PRIVATE_KEY' });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base_url', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getClientFileClient()).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });
});

describe('mapClientFileHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapClientFileHttpError(new HttpError('Unauthorized', 401), 'not found');
    expect(err.code).toBe('CLIENT_FILE_ERROR');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 403 to the client-admin per-user key requirement', () => {
    const err = mapClientFileHttpError(new HttpError('Forbidden', 403), 'not found');
    expect(err.code).toBe('CLIENT_FILE_ERROR');
    expect(err.message).toContain("client admin's per-user private key");
  });

  test('maps a 404 to the caller-supplied message', () => {
    const err = mapClientFileHttpError(new HttpError('Not Found', 404), 'Client file "x" not found.');
    expect(err.message).toBe('Client file "x" not found.');
  });

  test('passes any other HttpError message through without repeating the status', () => {
    const err = mapClientFileHttpError(
      new HttpError('Client file request failed (422): {"error":"bad status"}', 422),
      'not found'
    );
    expect(err.message).toBe('Client file request failed (422): {"error":"bad status"}');
  });

  test('maps a non-HttpError (e.g. network failure or blank id) to a generic message', () => {
    const err = mapClientFileHttpError(new Error('fetch failed'), 'not found');
    expect(err.code).toBe('CLIENT_FILE_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

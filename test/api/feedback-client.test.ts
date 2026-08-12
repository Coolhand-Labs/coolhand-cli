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

import { getFeedbackClient, mapFeedbackHttpError } from '../../src/api/feedback-client.js';
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

describe('getFeedbackClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({});
    (resolveClient as jest.Mock).mockResolvedValue(fakeClient);
    mockCoolhandCtor.mockImplementation((opts) => ({ __opts: opts }));
  });

  test('constructs Coolhand with the client private_key (not api_key) and base_url', async () => {
    await getFeedbackClient();
    expect(mockCoolhandCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'priv_key_abc', baseUrl: 'https://coolhandlabs.com' })
    );
  });

  test('passes clientId through to resolveClient', async () => {
    await getFeedbackClient({ clientId: 'acme' });
    expect(resolveClient).toHaveBeenCalledWith({}, 'acme');
  });

  test('throws NO_PRIVATE_KEY when the resolved client has no private_key', async () => {
    (resolveClient as jest.Mock).mockResolvedValue({ ...fakeClient, private_key: undefined });
    await expect(getFeedbackClient()).rejects.toMatchObject({ code: 'NO_PRIVATE_KEY' });
    expect(mockCoolhandCtor).not.toHaveBeenCalled();
  });

  test('propagates a CliError thrown by resolveClient (e.g. CLIENT_NOT_FOUND)', async () => {
    const { CliError } = await import('../../src/errors.js');
    (resolveClient as jest.Mock).mockRejectedValue(new CliError('CLIENT_NOT_FOUND', 'No client "x".'));
    await expect(getFeedbackClient({ clientId: 'x' })).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base_url', async () => {
    mockCoolhandCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getFeedbackClient()).rejects.toMatchObject({ code: 'INVALID_BASE_URL' });
  });
});

describe('mapFeedbackHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapFeedbackHttpError(new HttpError('Unauthorized', 401), 'not found');
    expect(err.code).toBe('FEEDBACK_ERROR');
    expect(err.message).toContain("coolhand login --scope private");
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapFeedbackHttpError(new HttpError('Not Found', 404), 'Feedback "abc" not found.');
    expect(err.code).toBe('FEEDBACK_ERROR');
    expect(err.message).toBe('Feedback "abc" not found.');
  });

  test('maps any other HttpError status to a generic message including the status', () => {
    const err = mapFeedbackHttpError(new HttpError('Server boom', 500), 'not found');
    expect(err.code).toBe('FEEDBACK_ERROR');
    expect(err.message).toContain('500');
    expect(err.message).toContain('Server boom');
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapFeedbackHttpError(new Error('fetch failed'), 'not found');
    expect(err.code).toBe('FEEDBACK_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

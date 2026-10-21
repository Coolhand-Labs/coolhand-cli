// Variables consumed inside the jest.mock factory must be prefixed with `mock` (jest hoisting rule).
const mockServiceCtor = jest.fn();

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
  PublicContentService: mockServiceCtor,
  HttpError: MockHttpError,
}));
jest.mock('../../src/config.js', () => ({
  loadConfig: jest.fn(),
  resolveClientForDryRun: jest.fn(),
}));

import { getHelpCenterClient, mapHelpCenterHttpError } from '../../src/api/help-center-client.js';
import { loadConfig, resolveClientForDryRun } from '../../src/config.js';
import { HttpError } from 'coolhand-node';

const storedClient = {
  client_id: 'client-1',
  client_name: 'Test Client',
  api_key: 'pub_key',
  private_key: 'priv_key_abc',
  base_url: 'https://coolhandlabs.com',
  saved_at: new Date().toISOString(),
};

describe('getHelpCenterClient', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadConfig as jest.Mock).mockResolvedValue({});
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(storedClient);
    mockServiceCtor.mockImplementation((opts) => ({ __opts: opts }));
  });

  test('with no stored client, builds the service with no key against the default server', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue(undefined);
    const { usesStoredKey } = await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith({
      apiKey: undefined,
      baseUrl: 'https://coolhandlabs.com',
      silent: true,
    });
    expect(usesStoredKey).toBe(false);
  });

  test('sends the stored public api_key, preferring it over the private key', async () => {
    const { usesStoredKey } = await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://coolhandlabs.com' })
    );
    expect(usesStoredKey).toBe(true);
  });

  test('falls back to the private key when the client has no public key', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue({ ...storedClient, api_key: undefined });
    await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'priv_key_abc' }));
  });

  test('uses the stored client base_url', async () => {
    (resolveClientForDryRun as jest.Mock).mockResolvedValue({ ...storedClient, base_url: 'https://staging.example.com' });
    await getHelpCenterClient();
    expect(mockServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pub_key', baseUrl: 'https://staging.example.com' })
    );
  });

  test('never sends the stored key to a different --base-url', async () => {
    const { usesStoredKey } = await getHelpCenterClient({ baseUrl: 'http://127.0.0.1:3111' });
    expect(mockServiceCtor).toHaveBeenCalledWith({
      apiKey: undefined,
      baseUrl: 'http://127.0.0.1:3111',
      silent: true,
    });
    expect(usesStoredKey).toBe(false);
  });

  test('still sends the stored key when --base-url names the same server (trailing slash ignored)', async () => {
    await getHelpCenterClient({ baseUrl: 'https://coolhandlabs.com/' });
    expect(mockServiceCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'pub_key' }));
  });

  test('passes clientId through to client resolution', async () => {
    await getHelpCenterClient({ clientId: 'acme' });
    expect(resolveClientForDryRun).toHaveBeenCalledWith({}, 'acme');
  });

  test('propagates a CliError from client resolution (e.g. CLIENT_NOT_FOUND)', async () => {
    const { CliError } = await import('../../src/errors.js');
    (resolveClientForDryRun as jest.Mock).mockRejectedValue(new CliError('CLIENT_NOT_FOUND', 'No client "x".'));
    await expect(getHelpCenterClient({ clientId: 'x' })).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  test('throws INVALID_BASE_URL when the SDK constructor rejects the base URL', async () => {
    mockServiceCtor.mockImplementation(() => {
      throw new Error('baseUrl must use https');
    });
    await expect(getHelpCenterClient({ baseUrl: 'http://example.com' })).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });
});

describe('mapHelpCenterHttpError', () => {
  const stored = { service: {} as never, usesStoredKey: true };
  const anonymous = { service: {} as never, usesStoredKey: false };

  test('maps a 401 with a stored key to a re-authenticate hint', () => {
    const err = mapHelpCenterHttpError(new HttpError('Unauthorized', 401), stored, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toContain('coolhand login');
  });

  test('maps a 401 without a stored key to a COOLHAND_API_KEY hint', () => {
    const err = mapHelpCenterHttpError(new HttpError('Unauthorized', 401), anonymous, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toContain('COOLHAND_API_KEY');
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapHelpCenterHttpError(new HttpError('Not Found', 404), anonymous, 'Help article "x" not found.');
    expect(err.message).toBe('Help article "x" not found.');
  });

  test('maps a 429 to a wait-and-retry message', () => {
    const err = mapHelpCenterHttpError(new HttpError('Too Many Requests', 429), anonymous, 'not found');
    expect(err.message).toContain('30 requests per minute');
    expect(err.message).toContain('Wait a minute');
  });

  test('passes any other HTTP error message through unchanged', () => {
    const err = mapHelpCenterHttpError(
      new HttpError('Help center request failed (500): boom', 500),
      anonymous,
      'not found'
    );
    expect(err.message).toBe('Help center request failed (500): boom');
  });

  test('wraps a non-HTTP error', () => {
    const err = mapHelpCenterHttpError(new Error('ECONNREFUSED'), anonymous, 'not found');
    expect(err.code).toBe('HELP_CENTER_ERROR');
    expect(err.message).toBe('Help center request failed: ECONNREFUSED');
  });
});

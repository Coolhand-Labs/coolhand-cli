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
  Coolhand: jest.fn(),
  HttpError: MockHttpError,
}));

import { mapLogHttpError } from '../../src/api/log-client.js';
import { HttpError } from 'coolhand-node';

describe('mapLogHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapLogHttpError(new HttpError('Unauthorized', 401), 'not found');
    expect(err.code).toBe('LOG_ERROR');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapLogHttpError(new HttpError('Not Found', 404), 'Log "abc" not found.');
    expect(err.message).toBe('Log "abc" not found.');
  });

  test('passes a 422 through with the server body, without repeating the SDK status prefix', () => {
    const message = 'Log request failed (422): {"errors":{"order":["must be one of: cost_desc"]}}';
    const err = mapLogHttpError(new HttpError(message, 422), 'not found');
    expect(err.code).toBe('LOG_ERROR');
    expect(err.message).toBe(message);
  });

  test('maps a 504 to a retryable hint', () => {
    const err = mapLogHttpError(new HttpError('Log request failed (504): {}', 504), 'not found');
    expect(err.code).toBe('LOG_ERROR');
    expect(err.message).toContain('timed out');
    expect(err.message).toContain('--per-page');
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapLogHttpError(new Error('fetch failed'), 'not found');
    expect(err.message).toContain('fetch failed');
  });
});

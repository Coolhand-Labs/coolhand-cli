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

import { mapWorkloadHttpError } from '../../src/api/workload-client.js';
import { HttpError } from 'coolhand-node';

describe('mapWorkloadHttpError', () => {
  test('maps a 401 to a private-key-required message with the re-authenticate command', () => {
    const err = mapWorkloadHttpError(new HttpError('Unauthorized', 401));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toContain('private API key is required');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 504 to a retryable narrowing hint', () => {
    const err = mapWorkloadHttpError(new HttpError('Gateway Timeout', 504));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toContain('timed out');
    expect(err.message).toContain('--per-page');
  });

  test('passes a 422 through with the server message intact', () => {
    const message = 'Workload request failed (422): {"errors":{"since":["is not a valid ISO8601 timestamp"]}}';
    const err = mapWorkloadHttpError(new HttpError(message, 422));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toBe(message);
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapWorkloadHttpError(new Error('fetch failed'));
    expect(err.code).toBe('WORKLOAD_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

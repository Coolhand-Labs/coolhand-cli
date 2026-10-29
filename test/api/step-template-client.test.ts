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
  HttpError: MockHttpError,
}));

import { mapStepTemplateHttpError } from '../../src/api/step-template-client.js';
import { HttpError } from 'coolhand-node';

describe('mapStepTemplateHttpError', () => {
  test('maps a 401 to a re-authenticate hint', () => {
    const err = mapStepTemplateHttpError(new HttpError('Unauthorized', 401), 'not found', 'narrow it');
    expect(err.code).toBe('STEP_TEMPLATE_ERROR');
    expect(err.message).toContain('coolhand login --scope private');
  });

  test('maps a 404 to the caller-supplied not-found message', () => {
    const err = mapStepTemplateHttpError(new HttpError('Not Found', 404), 'Step template "9" not found.', 'x');
    expect(err.code).toBe('STEP_TEMPLATE_ERROR');
    expect(err.message).toBe('Step template "9" not found.');
  });

  test('maps a 422 to a message that names --step-type and keeps the server detail', () => {
    const err = mapStepTemplateHttpError(
      new HttpError('Step template request failed (422): {"errors":{"step_type":["is invalid"]}}', 422),
      'not found',
      'x'
    );
    expect(err.code).toBe('STEP_TEMPLATE_ERROR');
    expect(err.message).toContain('--step-type');
    expect(err.message).toContain('is invalid');
  });

  test('maps a 504 to a retryable timeout message plus the caller-supplied hint', () => {
    const err = mapStepTemplateHttpError(new HttpError('Gateway Timeout', 504), 'not found', 'Narrow it with --search.');
    expect(err.code).toBe('STEP_TEMPLATE_ERROR');
    expect(err.message).toContain('retryable');
    expect(err.message).toContain('Narrow it with --search.');
  });

  test('passes any other HttpError message through unchanged', () => {
    const err = mapStepTemplateHttpError(
      new HttpError('Step template request failed (500): boom', 500),
      'not found',
      'x'
    );
    expect(err.message).toBe('Step template request failed (500): boom');
  });

  test('maps a non-HttpError (e.g. network failure) to a generic message', () => {
    const err = mapStepTemplateHttpError(new Error('fetch failed'), 'not found', 'x');
    expect(err.code).toBe('STEP_TEMPLATE_ERROR');
    expect(err.message).toContain('fetch failed');
  });
});

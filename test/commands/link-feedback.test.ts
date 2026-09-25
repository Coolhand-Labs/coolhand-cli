const mockBulkLinkFeedback = jest.fn();

jest.mock('../../src/api/feedback-client.js', () => ({
  getFeedbackClient: jest.fn().mockResolvedValue({ bulkLinkFeedback: mockBulkLinkFeedback }),
}));

import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseIds } from '../../src/commands/link-feedback.js';
import { getFeedbackClient } from '../../src/api/feedback-client.js';
import { logger } from '../../src/logger.js';

const ok = { linked: 2, already_linked: 1, errored: 0, not_found: ['zzz'] };

describe('link-feedback command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFeedbackClient as jest.Mock).mockResolvedValue({ bulkLinkFeedback: mockBulkLinkFeedback });
    mockBulkLinkFeedback.mockResolvedValue(ok);
  });

  test('calls bulkLinkFeedback with ids and no note by default', async () => {
    const code = await run({ optimizationId: 'opt', feedbackIds: ['a', 'b'] });
    expect(code).toBe(0);
    expect(mockBulkLinkFeedback).toHaveBeenCalledWith('opt', ['a', 'b'], {});
  });

  test('drops duplicate ids before linking', async () => {
    await run({ optimizationId: 'opt', feedbackIds: ['a', 'b', 'a'] });
    expect(mockBulkLinkFeedback).toHaveBeenCalledWith('opt', ['a', 'b'], {});
  });

  test('forwards note and client id', async () => {
    await run({ optimizationId: 'opt', feedbackIds: ['a'], note: 'why', clientId: 'c1' });
    expect(mockBulkLinkFeedback).toHaveBeenCalledWith('opt', ['a'], { note: 'why' });
    expect(getFeedbackClient).toHaveBeenCalledWith({ clientId: 'c1' });
  });

  test('prints counts and not_found ids', async () => {
    const spy = jest.spyOn(logger, 'info');
    await run({ optimizationId: 'opt', feedbackIds: ['a'] });
    const out = spy.mock.calls.map(([m]) => m).join('\n');
    expect(out).toContain('Linked: 2');
    expect(out).toContain('Already linked: 1');
    expect(out).toContain('Errored: 0');
    expect(out).toContain('zzz');
  });

  test('--json emits the result', async () => {
    const spy = jest.spyOn(logger, 'json');
    const code = await run({ optimizationId: 'opt', feedbackIds: ['a'], json: true });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledWith({ ok: true, result: ok });
  });

  test('exits non-zero when errored > 0', async () => {
    mockBulkLinkFeedback.mockResolvedValue({ ...ok, errored: 1 });
    expect(await run({ optimizationId: 'opt', feedbackIds: ['a'] })).toBe(1);
  });

  test('reads ids from a file and combines with args', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-'));
    const file = join(dir, 'ids.txt');
    await writeFile(file, 'b\nc, d\n');
    await run({ optimizationId: 'opt', feedbackIds: ['a'], file });
    expect(mockBulkLinkFeedback).toHaveBeenCalledWith('opt', ['a', 'b', 'c', 'd'], {});
  });

  test('errors with no ids and does not call the API', async () => {
    expect(await run({ optimizationId: 'opt', feedbackIds: [] })).toBe(1);
    expect(mockBulkLinkFeedback).not.toHaveBeenCalled();
  });

  test('errors on an unreadable file', async () => {
    expect(await run({ optimizationId: 'opt', feedbackIds: [], file: '/nonexistent/ids.txt' })).toBe(1);
  });

  test('401 gives a re-authenticate message and non-zero exit', async () => {
    mockBulkLinkFeedback.mockRejectedValue(Object.assign(new Error('nope'), { status: 401 }));
    const spy = jest.spyOn(logger, 'info');
    expect(await run({ optimizationId: 'opt', feedbackIds: ['a'] })).toBe(1);
    expect(spy.mock.calls.map(([m]) => m).join('\n')).toContain('coolhand login --scope private');
  });

  test('404 names the optimization', async () => {
    mockBulkLinkFeedback.mockRejectedValue(Object.assign(new Error('x'), { status: 404 }));
    const spy = jest.spyOn(logger, 'info');
    expect(await run({ optimizationId: 'opt9', feedbackIds: ['a'] })).toBe(1);
    expect(spy.mock.calls.map(([m]) => m).join('\n')).toContain('opt9');
  });

  test('parseIds splits on whitespace and commas', () => {
    expect(parseIds('a, b\n\nc\td')).toEqual(['a', 'b', 'c', 'd']);
  });
});

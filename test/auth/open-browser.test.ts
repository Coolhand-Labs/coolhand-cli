import { openBrowser } from '../../src/auth/open-browser.js';
import { EventEmitter } from 'events';

function makeFakeChild(): EventEmitter & { unref: jest.Mock } {
  const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
  child.unref = jest.fn();
  return child;
}

describe('openBrowser', () => {
  test('uses `open` on darwin and passes URL as single argv', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    await openBrowser('https://example.com/path?x=1', {
      platform: 'darwin',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('open');
    expect(args).toEqual(['https://example.com/path?x=1']);
  });

  test('uses `xdg-open` on linux', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    await openBrowser('https://example.com', {
      platform: 'linux',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    expect(spawnFn.mock.calls[0][0]).toBe('xdg-open');
  });

  test('uses `cmd /c start` on win32 with empty title placeholder', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    await openBrowser('https://example.com', {
      platform: 'win32',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '""', 'https://example.com']);
  });

  test('does not throw if spawn emits an error', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn().mockReturnValue(child);
    const p = openBrowser('https://example.com', {
      platform: 'darwin',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    child.emit('error', new Error('command not found'));
    await expect(p).resolves.toBeUndefined();
  });

  test('does not throw if spawn itself throws', async () => {
    const spawnFn = jest.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    await expect(
      openBrowser('https://example.com', {
        platform: 'darwin',
        spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
      })
    ).resolves.toBeUndefined();
  });
});

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

  test('uses `cmd /c start` on win32 with empty title placeholder, wrapped via cmd.exe with verbatim args', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    await openBrowser('https://example.com', {
      platform: 'win32',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toMatch(/cmd\.exe/i);
    expect(args[0]).toBe('/d');
    expect(args[1]).toBe('/s');
    expect(args[2]).toBe('/c');
    const cmdStr = args[3];
    expect(cmdStr).toContain('"cmd"');
    expect(cmdStr).toContain('"/c"');
    expect(cmdStr).toContain('"start"');
    expect(cmdStr).toContain('"https://example.com"');
    expect(opts.windowsVerbatimArguments).toBe(true);
    // The `""` empty-title placeholder arg is itself escaped like any other arg: its two
    // embedded quotes are doubled to `""""`, then the whole token is wrapped in an outer
    // pair of quotes — six quote characters in a row — and still parses under cmd.exe's
    // /S rules as a single empty-string token, preserving the "no window title" convention.
    expect(cmdStr).toContain('"cmd" "/c" "start" """""" "https://example.com"');
  });

  test('escapes an unescaped `&` in a malicious --base-url-derived URL on win32, keeping it inside the quoted segment', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    const maliciousUrl = 'https://ok.example.com&calc.exe&';
    await openBrowser(maliciousUrl, {
      platform: 'win32',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    const [, args] = spawnFn.mock.calls[0];
    const cmdStr = args[3];
    expect(cmdStr).toContain(`"${maliciousUrl}"`);
  });

  test('keeps the legitimate `&state=...` auth URL intact as a single quoted token on win32', async () => {
    const spawnFn = jest.fn().mockReturnValue(makeFakeChild());
    const authUrl = 'https://coolhandlabs.com/cli/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback&state=abc123';
    await openBrowser(authUrl, {
      platform: 'win32',
      spawnFn: spawnFn as unknown as typeof import('child_process').spawn,
    });
    const [, args] = spawnFn.mock.calls[0];
    const cmdStr = args[3];
    // `%` is doubled by the cmd.exe escaper to prevent env-var expansion.
    expect(cmdStr).toContain(`"${authUrl.replace(/%/g, '%%')}"`);
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

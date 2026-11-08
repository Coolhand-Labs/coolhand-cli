import { PassThrough } from 'stream';
import { readHookInput } from '../../src/hooks/stdin.js';

function streamOf(text: string | null): PassThrough & { isTTY?: boolean } {
  const s = new PassThrough();
  if (text !== null) {
    s.end(text);
  }
  return s;
}

describe('readHookInput', () => {
  it('parses a JSON object', async () => {
    expect(await readHookInput(streamOf('{"session_id":"a"}'))).toEqual({ session_id: 'a' });
  });

  it('returns null for empty, invalid, array and scalar input', async () => {
    expect(await readHookInput(streamOf(''))).toBeNull();
    expect(await readHookInput(streamOf('not json'))).toBeNull();
    expect(await readHookInput(streamOf('[1]'))).toBeNull();
    expect(await readHookInput(streamOf('3'))).toBeNull();
  });

  it('returns null for a TTY without reading', async () => {
    const tty = streamOf(null);
    tty.isTTY = true;
    expect(await readHookInput(tty)).toBeNull();
  });

  it('gives up when the agent never closes stdin', async () => {
    expect(await readHookInput(streamOf(null), 20)).toBeNull();
  });

  it('refuses an implausibly large payload', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(9 * 1024 * 1024) });
    expect(await readHookInput(streamOf(big))).toBeNull();
  });
});

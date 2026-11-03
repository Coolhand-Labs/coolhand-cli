import type { HookInput } from './types.js';

/** A hook payload is a few KB; anything bigger is not one. */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * Read and parse the JSON object an agent writes to a hook's stdin. Returns `null` for a TTY (a
 * human ran the command by hand), empty input, invalid JSON, or a non-object — a hook must never
 * throw over a payload it doesn't understand. Gives up after `timeoutMs` so a hook whose agent
 * never closes stdin can't hang the agent.
 */
export async function readHookInput(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  timeoutMs = 5000
): Promise<HookInput | null> {
  if (stream.isTTY) {
    return null;
  }

  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDIN_BYTES) {
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });

  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HookInput) : null;
  } catch {
    return null;
  }
}

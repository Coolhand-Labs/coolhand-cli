import { promises as fs } from 'fs';
import { extractLastTurn } from '../../sessions/claude-scanner.js';
import type { HookInput, HookTurn } from '../types.js';

/** How much of the transcript's tail to read. A turn full of tool output can run to megabytes. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Equal once whitespace is collapsed: the payload and the transcript may join a reply's text blocks differently. */
function sameText(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Claude Code `Stop` hook → a turn. The assistant text comes from `last_assistant_message` (the
 * transcript file is written asynchronously and can lag it). The user text, and the model, come
 * from the tail of `transcript_path` — that is also what covers the turn that invoked the skill,
 * whose prompt was submitted before the skill's hooks registered. If the transcript can't be read
 * the turn is still captured, just without the user half.
 *
 * Returns `null` for any other event or when there is nothing to send.
 */
export async function claudeTurn(input: HookInput): Promise<HookTurn | null> {
  const event = str(input.hook_event_name);
  if (event !== undefined && event !== 'Stop') {
    return null;
  }
  const sessionId = str(input.session_id);
  if (!sessionId) {
    return null;
  }

  let tail: ReturnType<typeof extractLastTurn> = {};
  const transcriptPath = str(input.transcript_path);
  if (transcriptPath) {
    try {
      tail = extractLastTurn(await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES));
    } catch {
      // Unreadable transcript: fall through with whatever the payload itself carries.
    }
  }

  const assistantText = str(input.last_assistant_message) ?? tail.assistantText;
  if (!assistantText) {
    return null;
  }

  return {
    sessionId,
    userText: tail.userText,
    assistantText,
    model: tail.model,
    // The transcript can lag the payload; only trust its request id if it is for the same reply.
    turnKey: sameText(tail.assistantText, assistantText) ? tail.assistantKey : undefined,
    cwd: str(input.cwd),
  };
}

import { promises as fs } from 'fs';
import { lastTurnFrom, parseExchanges, type Exchange } from '../../sessions/claude-scanner.js';
import type { EarlierExchange, HookInput, HookTurn } from '../types.js';
import { sameText, splitCurrent, str } from './shared.js';

/**
 * How much of the transcript's tail to read. A turn full of tool output can run to megabytes, and the
 * earlier exchanges are rebuilt from the same window, so anything older than this is simply not seen
 * (the turn's `history_truncated` flag says when that cost the conversation some of its history).
 */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

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

/**
 * Is the transcript's latest exchange this turn? Yes when its reply is the one the hook was given, or
 * when it has a prompt but no reply yet (the transcript is written asynchronously and can lag the hook
 * by exactly the reply). No when it shows some other reply: that is an earlier turn.
 */
function transcriptShowsThisTurn(tail: { userText?: string; assistantText?: string }, assistantText: string): boolean {
  if (tail.assistantText === undefined) {
    return tail.userText !== undefined;
  }
  return sameText(tail.assistantText, assistantText);
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

  let tail: ReturnType<typeof lastTurnFrom> = {};
  let earlier: EarlierExchange[] = [];
  let exchangeTimestamp: string | undefined;
  let current: Exchange | undefined;
  let skillBodies: HookTurn['skillBodies'];
  let earlierStamps: string[] = [];
  const transcriptPath = str(input.transcript_path);
  if (transcriptPath) {
    try {
      const parsed = parseExchanges(await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES));
      tail = lastTurnFrom(parsed);
      // Everything before the latest exchange that has a prompt of its own, oldest first.
      exchangeTimestamp = parsed.exchanges[parsed.exchanges.length - 1]?.timestamp;
      earlierStamps = parsed.exchanges.slice(0, -1).flatMap((e) => (e.timestamp ? [e.timestamp] : []));
      earlier = parsed.exchanges
        .slice(0, -1)
        .filter((e): e is typeof e & { userText: string } => typeof e.userText === 'string')
        .map((e) => ({ timestamp: e.timestamp, userText: e.userText, assistantText: e.assistantText, usage: e.usage, subagents: e.subagents, messages: e.messages }));
      current = parsed.exchanges[parsed.exchanges.length - 1];
      skillBodies = parsed.exchanges.flatMap((e) => (e.skill ? [{ ...e.skill, timestamp: e.timestamp }] : []));
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
    // Only trust the transcript's latest exchange as THIS turn (and so as the start of the skill's
    // conversation, if this is turn 1) when it shows this turn's reply, or shows its prompt and no
    // reply yet. A lagging transcript would otherwise make an earlier, pre-skill prompt the anchor.
    exchangeTimestamp: transcriptShowsThisTurn(tail, assistantText) ? exchangeTimestamp : undefined,
    earlier,
    earlierStamps,
    usage: current?.usage,
    subagents: current?.subagents,
    skillBodies,
    ...splitCurrent(current?.messages, assistantText),
  };
}

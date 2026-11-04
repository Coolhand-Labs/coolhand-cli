import { promises as fs } from 'fs';
import { lastTurnFrom, parseExchanges, SKILL_BODY_PREFIX, type Exchange } from '../../sessions/claude-scanner.js';
import type { AdapterContext, EarlierExchange, HookInput, HookTurn } from '../types.js';
import { earlierFrom, earlierStampsFrom, isSkillPattern, resolveSkill, sameText, skillLabel, splitCurrent, str } from './shared.js';

/**
 * How much of the transcript's tail to read. A turn full of tool output can run to megabytes, and the
 * earlier exchanges are rebuilt from the same window, so anything older than this is simply not seen
 * (the turn's `history_truncated` flag says when that cost the conversation some of its history).
 */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

async function readTail(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The command a typed `/name args` (or `/plugin:name args`) prompt names, without the plugin namespace. */
function slashCommandName(userText: string | undefined): string | undefined {
  const match = /^\/([^\s/]+)/.exec(userText ?? '');
  return match?.[1].split(':').pop();
}

/**
 * The skills the USER invoked in this session, oldest first: an exchange counts only when its prompt is the slash command
 * that names the skill whose body was injected. A skill the model loaded by itself (a `Skill` tool call) writes the same
 * body line but follows no matching command, so a session-wide hook never sends a session on its account.
 */
function slashInvokedSkills(exchanges: Exchange[]): Array<{ dir: string; text: string; timestamp?: string }> {
  return exchanges.flatMap((e) =>
    e.skill && slashCommandName(e.userText) === skillLabel(e.skill) ? [{ ...e.skill, timestamp: e.timestamp }] : []
  );
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
 * A skill's own hook runs only while that skill is active, so `--skill NAME` filters nothing. A hook that runs for EVERY
 * session (one a plugin ships) passes a `--skill` pattern (`*`, `acme-*`): then a turn is sent only when the transcript
 * shows the user invoked a matching skill with a slash command, and that skill (its folder name) is returned as `skill`.
 * `ctx.pinnedSkill` is the skill an earlier turn of this session resolved to: it is kept even after the invocation has
 * scrolled out of the transcript window, so a long session keeps being captured under one skill.
 *
 * Returns `null` for any other event, for a session that invoked no skill the pattern matches, or when there is nothing to send.
 */
export async function claudeTurn(input: HookInput, ctx: AdapterContext = {}): Promise<HookTurn | null> {
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
  let slashSkills: ReturnType<typeof slashInvokedSkills> = [];
  let earlierStamps: string[] = [];
  const pattern = ctx.skill && isSkillPattern(ctx.skill) ? ctx.skill : undefined;
  const transcriptPath = str(input.transcript_path);
  if (transcriptPath) {
    try {
      const bytes = await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
      // A session-wide hook runs after every turn of every session: skip decoding and parsing when no skill (whether the user
      // or the model loaded it) ever injected its body in this window. A skill body is injected as `SKILL_BODY_PREFIX <dir>`.
      if (pattern && !ctx.pinnedSkill && !bytes.includes(SKILL_BODY_PREFIX)) {
        return null;
      }
      const parsed = parseExchanges(bytes.toString('utf8'));
      slashSkills = slashInvokedSkills(parsed.exchanges);
      tail = lastTurnFrom(parsed);
      // Everything before the latest exchange that has a prompt of its own, oldest first.
      exchangeTimestamp = parsed.exchanges[parsed.exchanges.length - 1]?.timestamp;
      earlierStamps = earlierStampsFrom(parsed.exchanges);
      earlier = earlierFrom(parsed.exchanges);
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
  const skill = pattern ? ctx.pinnedSkill ?? resolveSkill(pattern, slashSkills) : undefined;
  if (pattern && !skill) {
    return null;
  }

  return {
    sessionId,
    ...(skill ? { skill } : {}),
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

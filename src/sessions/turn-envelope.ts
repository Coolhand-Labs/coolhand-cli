import { MAX_TURN_TEXT_CHARS, cleanText, messageSize, sanitizeBlock, sanitizeMessage, type ContentBlock } from './blocks.js';
import type { CaptureEnvelope } from './claude-scanner.js';
import { addUsage, emptySubagentUsage, emptyUsage, mergeSubagents, totalTokens, type SubagentUsage, type Usage } from './usage.js';
import type { EarlierExchange, HookAgent, HookTurn, TurnMessage } from '../hooks/types.js';

export { MAX_TURN_TEXT_CHARS };

/**
 * Cap on the characters of EARLIER messages sent with a turn (the current turn's own user message is
 * extra, and is itself capped at MAX_TURN_TEXT_CHARS). The payload grows with the conversation, so
 * when the history would exceed this the OLDEST whole exchanges are dropped and the most recent are
 * kept: the server should expect a truncated head, flagged by `metadata.history_truncated`. The newest
 * earlier exchange is always kept, even if it alone is over the cap. Counted in characters (UTF-16
 * code units), not bytes.
 */
export const HISTORY_BUDGET_CHARS = 200_000;

export interface PreparedMessages {
  /** The conversation so far, ending on the current turn's user message (when there is one). */
  messages: TurnMessage[];
  /** Messages dropped from the start of the history to stay inside HISTORY_BUDGET_CHARS (a count of messages in the transcript window: one that redacts to nothing is still counted, and anything older than the window is not). */
  omitted: number;
  /** True when part of the conversation since the skill was invoked is not in `messages`. */
  truncated: boolean;
  /**
   * Tokens the main-thread assistant messages spent across the same exchanges as the history, plus
   * this turn's: a CUMULATIVE total, so a replayed or late older turn can't double count. Absent when
   * the transcript shows none.
   */
  usage?: Usage;
  /** The same, for subagents (other models, so priced separately). Absent when there were none. */
  subagents?: SubagentUsage;
}

function promptMessage(userText: string): TurnMessage {
  return { role: 'user', content: cleanText(userText) };
}

/**
 * One exchange as redacted, capped messages: the prompt, then everything the transcript shows after it
 * (thinking, tool calls, tool results, replies) in order. A hand-built exchange with only reply text
 * (no transcript behind it) falls back to prompt + reply.
 */
function exchangeMessages(exchange: EarlierExchange): TurnMessage[] {
  const out: TurnMessage[] = [promptMessage(exchange.userText)];
  if (exchange.messages) {
    for (const raw of exchange.messages) {
      const message = sanitizeMessage(raw);
      if (message) {
        out.push(message);
      }
    }
  } else if (exchange.assistantText) {
    const reply = cleanText(exchange.assistantText);
    if (reply) {
      out.push({ role: 'assistant', content: reply });
    }
  }
  return out;
}

/** Characters an exchange will occupy once capped (an estimate: redaction usually shortens it, but `[REDACTED]` can replace a shorter secret). */
function cappedSize(exchange: EarlierExchange): number {
  const prompt = Math.min(exchange.userText.length, MAX_TURN_TEXT_CHARS);
  if (exchange.messages) {
    return prompt + exchange.messages.reduce((n, m) => n + messageSize(m), 0);
  }
  return prompt + Math.min(exchange.assistantText?.length ?? 0, MAX_TURN_TEXT_CHARS);
}

/** How many messages an exchange would have contributed (for `omitted`). */
function messageCount(exchange: EarlierExchange): number {
  return 1 + (exchange.messages ? exchange.messages.length : exchange.assistantText ? 1 : 0);
}

/**
 * The messages sent with turn `turnIndex`: every earlier message (prompts, thinking, tool calls and results,
 * replies) since the skill was invoked, in order, then this turn's user message. "Since the skill was invoked" is the session's
 * `anchor` — the timestamp of its first captured turn — and only exchanges a hook actually captured
 * (`captured`) are included, so nothing the user said before the skill ran, or while capture was off,
 * is uploaded, however many exchanges the transcript holds that no hook saw (`/compact`, image
 * prompts, a second Stop for one prompt). Without a usable anchor there is no history at all. What is
 * sent is prompts, thinking, tool calls and results and replies, redacted and capped like the turn
 * itself. If the start of the skill's conversation is no longer in the transcript window, or the history is over budget, the OLDEST part is what is missing and
 * `truncated` is set.
 */
export function prepareTurnMessages(
  turn: HookTurn,
  turnIndex: number,
  anchor: string | undefined,
  captured: ReadonlySet<string>
): PreparedMessages {
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
  const earlier = turn.earlier ?? [];

  // Exchanges at or after the anchor that a hook actually captured, in order. One with no usable
  // timestamp can't be placed, so it is left out (fail closed); inside the skill's conversation that
  // is a gap worth flagging. So is an answered exchange no hook captured (capture was off, or the hook
  // was killed): it is never swept up into a later upload. An uncaptured exchange with no reply (a
  // command, an interrupted prompt) is dropped quietly, because there was no turn to capture.
  const since: EarlierExchange[] = [];
  let gap = false;
  const usage = emptyUsage();
  const subagents = emptySubagentUsage();
  addUsage(usage, turn.usage);
  mergeSubagents(subagents, turn.subagents);
  if (turnIndex > 1 && !Number.isNaN(anchorMs)) {
    for (const e of earlier) {
      const ms = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
      if (Number.isNaN(ms)) {
        gap ||= since.length > 0;
      } else if (ms >= anchorMs) {
        if (e.timestamp && captured.has(e.timestamp)) {
          since.push(e);
          addUsage(usage, e.usage);
          mergeSubagents(subagents, e.subagents);
        } else if (e.assistantText) {
          gap = true;
        }
      }
    }
  }

  // Newest first, so the budget keeps the most recent; the newest is kept whatever its size.
  const kept: EarlierExchange[] = [];
  let used = 0;
  for (let i = since.length - 1; i >= 0; i--) {
    const size = cappedSize(since[i]);
    if (kept.length > 0 && used + size > HISTORY_BUDGET_CHARS) {
      break;
    }
    kept.unshift(since[i]);
    used += size;
  }
  const dropped = since.slice(0, since.length - kept.length);
  const omitted = dropped.reduce((n, e) => n + messageCount(e), 0);

  const messages = kept.flatMap(exchangeMessages);
  if (turn.userText) {
    messages.push(promptMessage(turn.userText));
  }
  // This turn's own tool loop (everything up to, not including, its final reply).
  for (const raw of turn.currentMessages ?? []) {
    const message = sanitizeMessage(raw);
    if (message) {
      messages.push(message);
    }
  }

  // Did we see where the skill's conversation began? Turn 1 is that start; later turns need the
  // anchor's own exchange to still be in the window.
  const stamps = turn.earlierStamps ?? earlier.flatMap((e) => (e.timestamp ? [e.timestamp] : []));
  // A captured exchange that can't be rendered (an image-only prompt: no text of its own, so there is
  // no user message to pair its reply with) is missing from the history; say so.
  const rendered = new Set(earlier.flatMap((e) => (e.timestamp ? [e.timestamp] : [])));
  const unrenderable =
    turnIndex > 1 && !Number.isNaN(anchorMs) && stamps.some((st) => Date.parse(st) >= anchorMs && captured.has(st) && !rendered.has(st));
  const anchorSeen = turnIndex <= 1 || (anchor !== undefined && (turn.exchangeTimestamp === anchor || stamps.includes(anchor)));
  return {
    messages,
    omitted,
    truncated: omitted > 0 || gap || unrenderable || !anchorSeen,
    ...(totalTokens(usage) > 0 ? { usage } : {}),
    ...(subagents.calls > 0 ? { subagents } : {}),
  };
}

/**
 * The blocks of this turn's reply: the transcript's own (thinking, then text) when it shows the final
 * message, otherwise just the text the hook was given.
 */
function replyBlocks(turn: HookTurn): ContentBlock[] {
  const blocks = (turn.finalReply ?? []).map(sanitizeBlock).filter((b): b is ContentBlock => b !== undefined);
  return blocks.some((b) => b.type === 'text') ? blocks : [{ type: 'text', text: cleanText(turn.assistantText) }];
}

/**
 * An Anthropic-shaped envelope for ONE turn captured by a hook, carrying the conversation so far.
 *
 * `request_body.messages` is the conversation since the skill was invoked, in order, ending on the last
 * message before this turn's reply (`prepareTurnMessages`, passed in as `prepared`); `response_body` is this turn's
 * reply. The server keeps one chat log per session and the newest turn replaces the stored one, so a
 * late-arriving older turn (a replay) is ignored by it.
 *
 * The url is `coolhand-hook://<agent>/session/<id>/turn/<n>` — deliberately NOT the
 * `claudecode://session/<id>` scheme `analyze-claude-sessions` uses. The server needs the session id
 * and the turn number from it. `response_body.id` is `<session>:<turn>:<digest>`, and the digest ties
 * it to the turn's content. It is no longer the server's dedup key, but stays unique per turn for
 * debugging and correlation. What goes in is the conversation as structured blocks: prompts, thinking,
 * tool calls, tool results and replies (subagent traffic and injected context excluded), all
 * secret-scrubbed and capped (see blocks.ts).
 */
export function buildTurnEnvelope(
  agent: HookAgent,
  turn: HookTurn,
  turnIndex: number,
  digest: string,
  prepared: PreparedMessages,
  /** The skill's text, sent as `request_body.system`. Redacted and capped here again, so state saved by an older version is scrubbed too. */
  system?: string
): CaptureEnvelope {
  return {
    url: `coolhand-hook://${agent}/session/${encodeURIComponent(turn.sessionId)}/turn/${turnIndex}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model: turn.model,
      ...(system ? { system: cleanText(system) } : {}),
      messages: prepared.messages,
    },
    response_body: {
      id: `${turn.sessionId}:${turnIndex}:${digest.slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      model: turn.model,
      content: replyBlocks(turn),
      ...(prepared.usage ? { usage: prepared.usage } : {}),
    },
    turnCount: turnIndex,
    projectPath: turn.cwd,
  };
}

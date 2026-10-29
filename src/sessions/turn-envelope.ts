import { redactSecrets } from './redact-secrets.js';
import type { CaptureEnvelope } from './claude-scanner.js';
import type { EarlierExchange, HookAgent, HookTurn, TurnMessage } from '../hooks/types.js';

/**
 * Per-half cap on the text sent. A reply can be megabytes, and a turn the server refuses for size
 * would be spooled to disk, retried and dropped; the cap keeps both the request and the spool small.
 */
export const MAX_TURN_TEXT_CHARS = 100_000;

function capText(text: string): string {
  return text.length > MAX_TURN_TEXT_CHARS ? `${text.slice(0, MAX_TURN_TEXT_CHARS)}\n…[truncated]` : text;
}

/**
 * Cap on the characters of EARLIER messages sent with a turn (the current turn's own user message is
 * extra, and is itself capped at MAX_TURN_TEXT_CHARS). The payload grows with the conversation, so
 * when the history would exceed this the OLDEST whole exchanges are dropped and the most recent are
 * kept: the server should expect a truncated head, flagged by `metadata.history_truncated`.
 */
export const HISTORY_BUDGET_CHARS = 200_000;

export interface PreparedMessages {
  /** The conversation so far, ending on the current turn's user message (when there is one). */
  messages: TurnMessage[];
  /** Messages dropped from the start of the history to stay inside HISTORY_BUDGET_CHARS. */
  omitted: number;
  /** True when part of the conversation since the skill was invoked is not in `messages`. */
  truncated: boolean;
}

/** One exchange as redacted, capped messages. */
function exchangeMessages(exchange: EarlierExchange): TurnMessage[] {
  const messages: TurnMessage[] = [{ role: 'user', content: capText(redactSecrets(exchange.userText).trim()) }];
  const reply = exchange.assistantText ? capText(redactSecrets(exchange.assistantText).trim()) : '';
  if (reply) {
    messages.push({ role: 'assistant', content: reply });
  }
  return messages;
}

/**
 * The messages sent with turn `turnIndex`: every earlier user and assistant text since the skill was
 * invoked, in order, then this turn's user message. Turn N has N−1 earlier exchanges, so a turn never
 * carries anything the user said before the skill ran. Text only, redacted exactly like the turn
 * itself. If the transcript no longer shows all N−1 earlier exchanges, or the history is over budget,
 * the OLDEST are the ones missing and `truncated` is set.
 */
export function prepareTurnMessages(turn: HookTurn, turnIndex: number): PreparedMessages {
  const wanted = Math.max(0, turnIndex - 1);
  const available = wanted === 0 ? [] : (turn.earlier ?? []).slice(-wanted);

  const exchanges = available.map(exchangeMessages);
  let size = exchanges.reduce((sum, ms) => sum + ms.reduce((n, m) => n + m.content.length, 0), 0);
  let omitted = 0;
  while (exchanges.length > 0 && size > HISTORY_BUDGET_CHARS) {
    const dropped = exchanges.shift() as TurnMessage[];
    size -= dropped.reduce((n, m) => n + m.content.length, 0);
    omitted += dropped.length;
  }

  const messages = exchanges.flat();
  if (turn.userText) {
    messages.push({ role: 'user', content: capText(redactSecrets(turn.userText).trim()) });
  }
  const shortfall = wanted - available.length;
  return { messages, omitted, truncated: omitted > 0 || shortfall > 0 };
}

/**
 * An Anthropic-shaped envelope for ONE turn captured by a hook, carrying the conversation so far.
 *
 * `request_body.messages` is every earlier user and assistant text since the skill was invoked, in
 * order, ending on this turn's user message (`prepareTurnMessages`); `response_body` is this turn's
 * reply. The server keeps one chat log per session and the newest turn replaces the stored one, so a
 * late-arriving older turn (a replay) is ignored by it.
 *
 * The url is `coolhand-hook://<agent>/session/<id>/turn/<n>` — deliberately NOT the
 * `claudecode://session/<id>` scheme `analyze-claude-sessions` uses. The server needs the session id
 * and the turn number from it. `response_body.id` is `<session>:<turn>:<digest>`, and the digest ties
 * it to the turn's content. It is no longer the server's dedup key, but stays unique per turn for
 * debugging and correlation. Only user and assistant text goes in — no tool calls, tool results or
 * thinking — and all of it is secret-scrubbed.
 */
export function buildTurnEnvelope(
  agent: HookAgent,
  turn: HookTurn,
  turnIndex: number,
  digest: string
): CaptureEnvelope {
  const assistantText = capText(redactSecrets(turn.assistantText).trim());

  return {
    url: `coolhand-hook://${agent}/session/${encodeURIComponent(turn.sessionId)}/turn/${turnIndex}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model: turn.model,
      messages: prepareTurnMessages(turn, turnIndex).messages,
    },
    response_body: {
      id: `${turn.sessionId}:${turnIndex}:${digest.slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      model: turn.model,
      content: [{ type: 'text', text: assistantText }],
    },
    turnCount: turnIndex,
    projectPath: turn.cwd,
  };
}

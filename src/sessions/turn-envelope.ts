import { redactSecrets } from './redact-secrets.js';
import type { CaptureEnvelope } from './claude-scanner.js';
import type { HookAgent, HookTurn } from '../hooks/types.js';

/**
 * Per-half cap on the text sent. A reply can be megabytes, and a turn the server refuses for size
 * would be spooled to disk, retried and dropped; the cap keeps both the request and the spool small.
 */
export const MAX_TURN_TEXT_CHARS = 100_000;

function capText(text: string): string {
  return text.length > MAX_TURN_TEXT_CHARS ? `${text.slice(0, MAX_TURN_TEXT_CHARS)}\n…[truncated]` : text;
}

/**
 * An Anthropic-shaped envelope for ONE user→assistant exchange captured by a hook.
 *
 * The url is `coolhand-hook://<agent>/session/<id>/turn/<n>` — deliberately NOT the
 * `claudecode://session/<id>` scheme `analyze-claude-sessions` uses, because the server's
 * `claude_code` ingestor treats that as a whole-session log and deduplicates on the session id,
 * which would collapse every turn after the first. `response_body.id` is `<session>:<turn>:<digest>`:
 * unique per turn and tied to the turn's content, so two overlapping hook runs that picked the same
 * turn number for different turns stay distinguishable. The server does NOT dedup on it (a live test
 * posted one id twice and got two logs), so a re-send is a second log: the id is a stable correlation
 * key for consumers to dedup on, not a guard. Only user and assistant text goes in — no tool calls,
 * tool results or thinking — and all of it is secret-scrubbed.
 */
export function buildTurnEnvelope(
  agent: HookAgent,
  turn: HookTurn,
  turnIndex: number,
  digest: string
): CaptureEnvelope {
  const userText = turn.userText ? capText(redactSecrets(turn.userText).trim()) : '';
  const assistantText = capText(redactSecrets(turn.assistantText).trim());

  return {
    url: `coolhand-hook://${agent}/session/${encodeURIComponent(turn.sessionId)}/turn/${turnIndex}`,
    method: 'POST',
    status_code: 200,
    request_body: {
      model: turn.model,
      messages: userText ? [{ role: 'user', content: userText }] : [],
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

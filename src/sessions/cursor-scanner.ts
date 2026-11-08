import type { RawMessage } from './blocks.js';
import type { Exchange, ParsedExchanges } from './claude-scanner.js';

/**
 * Cursor's transcript format is not documented, so this reads the shape it is believed to have and
 * skips whatever it doesn't recognise: JSONL, one message per line, each carrying a `role`
 * (`user` | `assistant`, on the line or on its `message`) and a `content` that is a string or an
 * array of blocks. Unverified against a real Cursor run; see docs/hook-capture.md.
 *
 * Consequences of the assumed shape: a user line holding `tool_result` blocks is only a tool result (any
 * text riding along is dropped), and any other user line, `<user_query>` or not, starts an exchange with
 * its text as the prompt. History placement needs a `timestamp` on user lines; without one the turns are
 * sent without history and flagged `history_truncated`.
 */

function isToolResultBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result';
}

function blockType(block: unknown): unknown {
  return block && typeof block === 'object' ? (block as { type?: unknown }).type : undefined;
}

/** Cursor wraps what the user typed in `<user_query>`; the wrapper is not part of the prompt. */
function unwrapUserQuery(text: string): string {
  const match = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  return (match ? match[1] : text).trim();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (blockType(b) === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter((part) => part.trim().length > 0)
      .join('\n');
  }
  return '';
}

function roleOf(event: Record<string, unknown>, message: Record<string, unknown>): 'user' | 'assistant' | undefined {
  for (const candidate of [message.role, event.role, event.type]) {
    if (candidate === 'user' || candidate === 'assistant') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Walk a Cursor transcript (or a window of one; a leading partial line is skipped like any other
 * unparseable line) and return its user→assistant exchanges in order. Pure function, never throws.
 * No token usage and no skill body: Cursor's transcript is not known to carry either.
 */
export function parseCursorExchanges(content: string): ParsedExchanges {
  const exchanges: Exchange[] = [];
  let model: string | undefined;
  let current: Exchange | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') {
      continue;
    }
    const message = (event.message && typeof event.message === 'object' ? event.message : event) as Record<string, unknown>;
    const role = roleOf(event, message);
    const blocks = Array.isArray(message.content) ? message.content : [];

    if (role === 'user') {
      // Tool results come back as user lines; they belong to the exchange in progress.
      const results = blocks.filter(isToolResultBlock);
      if (results.length > 0) {
        if (current) {
          (current.messages ??= []).push({ role: 'user', blocks: results });
        }
        continue;
      }
      const text = unwrapUserQuery(textOf(message.content));
      if (!text) {
        continue;
      }
      current = { userText: text };
      const stamp = typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : message.timestamp;
      if (typeof stamp === 'string' && stamp) {
        current.timestamp = stamp;
      }
      exchanges.push(current);
      continue;
    }

    if (role === 'assistant') {
      if (!current) {
        current = {};
        exchanges.push(current);
      }
      const assistantBlocks: unknown[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...blocks];
      const raw: RawMessage = { role: 'assistant', blocks: assistantBlocks };
      (current.messages ??= []).push(raw);
      const text = textOf(assistantBlocks).trim();
      if (text) {
        current.assistantText = text;
      }
      if (typeof message.model === 'string' && message.model) {
        model = message.model;
      }
    }
  }

  return { exchanges, model };
}

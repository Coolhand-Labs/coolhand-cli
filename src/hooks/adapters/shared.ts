import { rawMessageText, type RawMessage } from '../../sessions/blocks.js';

/** Equal once whitespace is collapsed: the payload and the transcript may join a reply's text blocks differently. */
export function sameText(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * Split this turn's messages into its tool loop and its final reply. The final reply is the last
 * assistant message, and only when its text is the reply the hook was given (otherwise the transcript
 * hasn't caught up, and the reply is sent as the text the hook has, with the loop as far as it shows).
 */
export function splitCurrent(messages: RawMessage[] | undefined, reply: string): { currentMessages: RawMessage[]; finalReply?: unknown[] } {
  const all = messages ?? [];
  const last = all[all.length - 1];
  if (last && last.role === 'assistant' && sameText(rawMessageText(last), reply)) {
    return { currentMessages: all.slice(0, -1), finalReply: last.blocks };
  }
  return { currentMessages: all };
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

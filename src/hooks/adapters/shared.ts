import { rawMessageText, type RawMessage } from '../../sessions/blocks.js';
import type { Exchange } from '../../sessions/claude-scanner.js';
import type { EarlierExchange } from '../types.js';

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

/** The exchanges before the latest one that have a prompt of their own, as `earlier` history (oldest first). */
export function earlierFrom(exchanges: Exchange[]): EarlierExchange[] {
  return exchanges
    .slice(0, -1)
    .filter((e): e is Exchange & { userText: string } => typeof e.userText === 'string')
    .map((e) => ({ timestamp: e.timestamp, userText: e.userText, assistantText: e.assistantText, usage: e.usage, subagents: e.subagents, messages: e.messages }));
}

/** Timestamps of EVERY exchange before the latest, including ones with no prompt text of their own. */
export function earlierStampsFrom(exchanges: Exchange[]): string[] {
  return exchanges.slice(0, -1).flatMap((e) => (e.timestamp ? [e.timestamp] : []));
}

/** Does a skill (its declared `name` and the directory it was loaded from) answer to `--skill`: by name or by its directory's name. */
export function skillMatches(skill: string, candidate: { name?: string; dir: string }): boolean {
  return candidate.name === skill || candidate.dir.split(/[\\/]/).filter(Boolean).pop() === skill;
}

/** A `--skill` value that ends in `*` is a pattern: `*` is any skill, `acme-*` any skill whose declared name starts with `acme-`. */
export function isSkillPattern(skill: string): boolean {
  return skill.endsWith('*');
}

/** Does a skill answer to a `--skill` value: by name or directory, or, for a pattern, by the prefix of its declared name. */
export function skillMatchesPattern(skill: string, candidate: { name?: string; dir: string }): boolean {
  return isSkillPattern(skill) ? (candidate.name ?? '').startsWith(skill.slice(0, -1)) : skillMatches(skill, candidate);
}

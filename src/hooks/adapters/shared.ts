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

/** The name a skill goes by: its declared `name`, else the name of the directory it was loaded from (Claude Code records only that). */
export function skillLabel(candidate: { name?: string; dir: string }): string {
  return candidate.name || candidate.dir.split(/[\\/]/).filter(Boolean).pop() || '';
}

/** The alternatives of a `--skill` value: `qa-*|some-qa-skill` is a prefix pattern or an exact name, whichever matches. */
function alternatives(skill: string): string[] {
  return skill.split('|').map((part) => part.trim()).filter(Boolean);
}

/**
 * A `--skill` value is a pattern when it ends in `*` (`*` is any skill, `acme-*` any skill whose name starts with `acme-`)
 * or lists several alternatives separated by `|` (`acme-*|other-skill`), each a prefix pattern or an exact name.
 */
export function isSkillPattern(skill: string): boolean {
  return skill.endsWith('*') || skill.includes('|');
}

/** Does a skill answer to a `--skill` value: by name or directory, or, for a pattern, by the prefix of its name or any alternative. */
export function skillMatchesPattern(skill: string, candidate: { name?: string; dir: string }): boolean {
  if (!isSkillPattern(skill)) {
    return skillMatches(skill, candidate);
  }
  return alternatives(skill).some((alt) =>
    alt.endsWith('*') ? skillLabel(candidate).startsWith(alt.slice(0, -1)) : skillMatches(alt, candidate)
  );
}

/** The skill a `--skill` value matched among the skills a session invoked (oldest first): a pattern resolves to the first match, never to itself. */
export function resolveSkill(skill: string, invoked: Array<{ name?: string; dir: string }>): string | undefined {
  if (!isSkillPattern(skill)) {
    return skill;
  }
  const hit = invoked.find((s) => skillMatchesPattern(skill, s));
  return hit ? skillLabel(hit) : undefined;
}

import type { RawMessage } from '../sessions/blocks.js';
import type { SubagentUsage, Usage } from '../sessions/usage.js';

/** Agents whose hook payloads `capture-turn` understands. `cursor` is built from Cursor's docs and unverified in a real Cursor run. */
export const HOOK_AGENTS = ['claude', 'copilot', 'cursor'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** One completed user→assistant exchange, normalised across agents. */
export interface HookTurn {
  /** The agent's own session/conversation id. Stable across every turn of a session. */
  sessionId: string;
  /** The skill this turn belongs to, when the adapter resolved it from a `--skill` pattern. */
  skill?: string;
  /** What the user typed. Missing when the agent's payload and transcript don't expose it. */
  userText?: string;
  /** The assistant's final reply for the turn. Always non-empty. */
  assistantText: string;
  model?: string;
  /** Identifies this exact turn when the agent exposes something unique to it. */
  turnKey?: string;
  /** Working directory of the session, when the payload carries one. */
  cwd?: string;
  /** When this turn's user line was written (ISO 8601), if the transcript says. */
  exchangeTimestamp?: string;
  /**
   * The exchanges before this turn that the agent's transcript still shows, oldest first, including
   * ones from before the skill was invoked. `prepareTurnMessages` keeps only those at or after the
   * session's anchor (the first captured turn).
   */
  earlier?: EarlierExchange[];
  /**
   * Timestamps of EVERY earlier exchange the transcript shows, including ones with no text of their
   * own (an image-only prompt), which `earlier` leaves out. Used only to tell whether the anchor's
   * exchange is still in view.
   */
  earlierStamps?: string[];
  /** Tokens the main-thread assistant messages of THIS exchange spent, as far as the transcript shows. */
  usage?: Usage;
  /** What subagents spent during this exchange, per model. */
  subagents?: SubagentUsage;
  /**
   * This turn's own tool loop: everything after its prompt up to, not including, its final reply (the
   * transcript is the source; empty when the turn used no tools or the transcript hasn't caught up).
   */
  currentMessages?: RawMessage[];
  /** The raw blocks (thinking, text) of this turn's final reply, when the transcript shows it. */
  finalReply?: unknown[];
  /**
   * Skill bodies the transcript shows being injected, with when. The caller picks the one for its skill: `name` (the
   * declared name, when the agent records it) or the name of `dir` can match `--skill`.
   */
  skillBodies?: Array<{ dir: string; text: string; timestamp?: string; name?: string }>;
}

/** A user message and the assistant's final text reply to it, from earlier in the session. */
export interface EarlierExchange {
  /** When the user line was written (ISO 8601); an exchange without one can't be placed relative to the anchor. */
  timestamp?: string;
  userText: string;
  assistantText?: string;
  usage?: Usage;
  subagents?: SubagentUsage;
  /** What came after the prompt: thinking, tool calls and results, replies. Absent for a hand-built exchange (text only). */
  messages?: RawMessage[];
}

export type { TurnMessage } from '../sessions/blocks.js';

/** A parsed hook payload: whatever JSON the agent wrote to stdin. */
export type HookInput = Record<string, unknown>;

/** What an adapter needs besides the hook payload. */
export interface AdapterContext {
  /** The `--skill` the hook was installed for. */
  skill?: string;
  /** The skill a `--skill` pattern resolved to on an earlier turn of this session, kept so a long session stays on it. Claude only: Copilot's transcript is cumulative, so its adapter ignores this. */
  pinnedSkill?: string;
}

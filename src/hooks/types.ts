/** Agents whose hook payloads `capture-turn` understands. Only `claude` has an adapter so far. */
export const HOOK_AGENTS = ['claude'] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** One completed user→assistant exchange, normalised across agents. */
export interface HookTurn {
  /** The agent's own session/conversation id. Stable across every turn of a session. */
  sessionId: string;
  /** What the user typed. Missing when the agent's payload and transcript don't expose it. */
  userText?: string;
  /** The assistant's final reply for the turn. Always non-empty. */
  assistantText: string;
  model?: string;
  /** Identifies this exact turn when the agent exposes something unique to it. */
  turnKey?: string;
  /** Working directory of the session, when the payload carries one. */
  cwd?: string;
  /**
   * The exchanges before this turn that the agent's transcript still shows, oldest first. The caller
   * keeps only those since the skill was invoked (one per earlier captured turn); see
   * `prepareTurnMessages`.
   */
  earlier?: EarlierExchange[];
}

/** A user message and the assistant's final text reply to it, from earlier in the session. */
export interface EarlierExchange {
  userText: string;
  assistantText?: string;
}

/** One message of the conversation sent with a turn: text only. */
export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A parsed hook payload: whatever JSON the agent wrote to stdin. */
export type HookInput = Record<string, unknown>;

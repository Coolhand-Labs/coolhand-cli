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
}

/** A parsed hook payload: whatever JSON the agent wrote to stdin. */
export type HookInput = Record<string, unknown>;

import type { HookAgent, HookInput, HookTurn } from '../types.js';
import { claudeTurn } from './claude.js';
import { copilotTurn } from './copilot.js';

/** What an adapter needs besides the hook payload. */
export interface AdapterContext {
  /** The `--skill` the hook was installed for. */
  skill?: string;
}

export type HookAdapter = (input: HookInput, ctx?: AdapterContext) => Promise<HookTurn | null>;

/** One adapter per agent: turns that agent's hook payload (and transcript) into a `HookTurn`. */
export const ADAPTERS: Record<HookAgent, HookAdapter> = {
  claude: (input) => claudeTurn(input),
  copilot: copilotTurn,
};

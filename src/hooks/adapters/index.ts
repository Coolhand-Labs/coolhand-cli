import type { AdapterContext, HookAgent, HookInput, HookTurn } from '../types.js';
import { claudeTurn } from './claude.js';
import { copilotTurn } from './copilot.js';
import { cursorTurn } from './cursor.js';

export type HookAdapter = (input: HookInput, ctx?: AdapterContext) => Promise<HookTurn | null>;

/** One adapter per agent: turns that agent's hook payload (and transcript) into a `HookTurn`. */
export const ADAPTERS: Record<HookAgent, HookAdapter> = {
  claude: claudeTurn,
  copilot: copilotTurn,
  cursor: cursorTurn,
};

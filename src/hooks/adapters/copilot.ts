import { createReadStream } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { isWantedLine, parseCopilotExchanges } from '../../sessions/copilot-scanner.js';
import type { EarlierExchange, HookInput, HookTurn } from '../types.js';
import type { AdapterContext } from './index.js';
import { splitCurrent, str } from './shared.js';

/** The transcript is written asynchronously and can lag `Stop` by the reply: wait this long, this many times, for it. */
const LAG_WAIT_MS = 250;
const LAG_RETRIES = 4;

/**
 * The lines of the transcript that matter. Copilot snapshots the whole conversation into the file on
 * every model call, so it is streamed and filtered rather than read whole.
 */
async function readEvents(filePath: string): Promise<string> {
  const kept: string[] = [];
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (isWantedLine(line)) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Does this exchange's skill invocation name `skill`: by its declared name or by its directory's name. */
function invokes(e: { skillName?: string; skill?: { dir: string } }, skill: string): boolean {
  return e.skillName === skill || path.basename(e.skill?.dir ?? '') === skill;
}

/**
 * VS Code Copilot `Stop` hook → a turn. The payload carries only the session id and `transcript_path`
 * (`~/.copilot/session-state/<id>/events.jsonl`), so the prompt, the reply, the tool loop and the
 * token usage all come from that file. Both the PascalCase (`session_id`, `transcript_path`) and the
 * camelCase (`sessionId`, `transcriptPath`) spellings of the payload are understood.
 *
 * A Copilot hook runs for EVERY chat in the workspace, so a turn is sent only when the transcript shows
 * the `--skill` skill was invoked in this session (a `skill.invoked` event), at or before this turn.
 * Without `--skill`, or for a chat that never invoked it, nothing is sent.
 *
 * Returns `null` for any other event, an unrelated chat, or when there is nothing to send.
 */
export async function copilotTurn(input: HookInput, ctx: AdapterContext = {}): Promise<HookTurn | null> {
  const event = str(input.hook_event_name);
  if (event !== undefined && event !== 'Stop' && event !== 'agentStop') {
    return null;
  }
  const sessionId = str(input.session_id) ?? str(input.sessionId);
  const transcriptPath = str(input.transcript_path) ?? str(input.transcriptPath);
  if (!sessionId || !transcriptPath || !ctx.skill) {
    return null;
  }

  const skill = ctx.skill;
  let parsed: ReturnType<typeof parseCopilotExchanges>;
  try {
    for (let attempt = 0; ; attempt++) {
      parsed = parseCopilotExchanges(await readEvents(transcriptPath));
      if (parsed.exchanges[parsed.exchanges.length - 1]?.assistantText || attempt >= LAG_RETRIES) {
        break;
      }
      // A chat that never used the skill has nothing to wait for.
      if (!parsed.exchanges.some((e) => invokes(e, skill))) {
        return null;
      }
      await wait(LAG_WAIT_MS);
    }
  } catch {
    return null;
  }

  const { exchanges } = parsed;
  const current = exchanges[exchanges.length - 1];
  if (!current?.assistantText || !exchanges.some((e) => invokes(e, skill))) {
    return null;
  }

  const earlierExchanges = exchanges.slice(0, -1);
  const earlier: EarlierExchange[] = earlierExchanges
    .filter((e): e is typeof e & { userText: string } => typeof e.userText === 'string')
    .map((e) => ({ timestamp: e.timestamp, userText: e.userText, assistantText: e.assistantText, usage: e.usage, messages: e.messages }));

  return {
    sessionId,
    userText: current.userText,
    assistantText: current.assistantText,
    model: parsed.model,
    turnKey: current.assistantKey,
    cwd: str(input.cwd),
    exchangeTimestamp: current.timestamp,
    earlier,
    earlierStamps: earlierExchanges.flatMap((e) => (e.timestamp ? [e.timestamp] : [])),
    usage: current.usage,
    skillBodies: exchanges.flatMap((e) => (e.skill ? [{ ...e.skill, timestamp: e.timestamp }] : [])),
    ...splitCurrent(current.messages, current.assistantText),
  };
}

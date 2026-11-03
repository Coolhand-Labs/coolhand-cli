import { createReadStream } from 'fs';
import { logHookEvent } from '../hook-log.js';
import { createInterface } from 'readline';
import { isWantedLine, parseCopilotExchanges } from '../../sessions/copilot-scanner.js';
import type { AdapterContext, HookInput, HookTurn } from '../types.js';
import { earlierFrom, earlierStampsFrom, isSkillPattern, skillMatchesPattern, splitCurrent, str } from './shared.js';

/**
 * The transcript is written asynchronously and Claude's can lag its `Stop` by the reply. Copilot's was in the file
 * 15 to 20 ms BEFORE `Stop` in the three recorded turns, so this is a precaution: wait this long, this many times, for it.
 */
const LAG_WAIT_MS = 250;
const LAG_RETRIES = 4;

/**
 * The lines of the transcript that matter. Copilot snapshots the whole conversation into the file on
 * every model call, so it is streamed and filtered rather than read whole.
 */
async function readEvents(filePath: string): Promise<string> {
  // `parseCopilotExchanges` applies the same filter, so it stays safe when called on a whole file; this pass only keeps memory small.
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

/** Does this exchange's skill invocation name `skill`: by its declared name or by its directory's name, or a `--skill` pattern. */
function invokes(e: { skills?: Array<{ name: string; dir: string }> }, skill: string): boolean {
  return (e.skills ?? []).some((s) => skillMatchesPattern(skill, s));
}

/** The skill a `--skill` value matched in this session: for a pattern the first one invoked (never the pattern itself), for a plain name that name. */
function resolveSkill(exchanges: Array<{ skills?: Array<{ name: string; dir: string }> }>, skill: string): string | undefined {
  if (!isSkillPattern(skill)) {
    return skill;
  }
  for (const e of exchanges) {
    const hit = (e.skills ?? []).find((s) => skillMatchesPattern(skill, s));
    if (hit) {
      return hit.name;
    }
  }
  return undefined;
}

/**
 * VS Code Copilot `Stop` hook → a turn. The payload carries only the session id and `transcript_path`
 * (`~/.copilot/session-state/<id>/events.jsonl`), so the prompt, the reply, the tool loop and the
 * token usage all come from that file. Both the PascalCase (`session_id`, `transcript_path`) and the
 * camelCase (`sessionId`, `transcriptPath`) spellings of the payload are understood.
 *
 * A Copilot hook runs for EVERY chat in the workspace, so a turn is sent only when the transcript shows
 * the `--skill` skill was invoked in this session (a `skill.invoked` event), at or before this turn.
 * `--skill` may be a pattern (`*`, `acme-*`): then any matching skill counts, and the first one invoked in
 * the session is returned as `skill`. Without `--skill`, or for a chat that never invoked it, nothing is sent.
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
  } catch (err) {
    // Not the normal "unrelated chat" path: say why nothing was captured, so a broken hook can be told from a quiet one.
    await logHookEvent(`capture-turn (copilot): could not read the transcript: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    return null;
  }

  const { exchanges } = parsed;
  const current = exchanges[exchanges.length - 1];
  if (!current?.assistantText || !exchanges.some((e) => invokes(e, skill))) {
    return null;
  }

  const resolved = resolveSkill(exchanges, skill);
  if (!resolved) {
    return null;
  }
  return {
    sessionId,
    skill: resolved,
    userText: current.userText,
    assistantText: current.assistantText,
    model: parsed.model,
    turnKey: current.assistantKey,
    cwd: str(input.cwd),
    exchangeTimestamp: current.timestamp,
    earlier: earlierFrom(exchanges),
    earlierStamps: earlierStampsFrom(exchanges),
    usage: current.usage,
    skillBodies: exchanges.flatMap((e) => (e.skills ?? []).map((s) => ({ dir: s.dir, text: s.text, name: s.name, timestamp: e.timestamp }))),
    ...splitCurrent(current.messages, current.assistantText),
  };
}

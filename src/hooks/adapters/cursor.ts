import { parseCursorExchanges } from '../../sessions/cursor-scanner.js';
import { lastTurnFrom, type Exchange } from '../../sessions/claude-scanner.js';
import { loadTurnState, saveTurnState } from '../turn-state.js';
import type { HookInput, HookTurn } from '../types.js';
import { cleanText } from '../../sessions/blocks.js';
import { logHookEvent } from '../hook-log.js';
import { earlierFrom, earlierStampsFrom, readTail, splitCurrent, str, TRANSCRIPT_TAIL_BYTES, transcriptShowsThisTurn } from './shared.js';

/** A prefix this short ("yes", "continue") says too little to call two prompts the same. */
const MIN_PREFIX_CHARS = 20;

/** Same prompt once whitespace is collapsed, or (for a prefix of at least MIN_PREFIX_CHARS) one is a prefix of the other. */
function samePrompt(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ' ').trim();
  const y = b.replace(/\s+/g, ' ').trim();
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short === long || (short.length >= MIN_PREFIX_CHARS && long.startsWith(short));
}

/** A stashed prompt is only ever one user message; this bounds a pathological paste. */
const MAX_PENDING_PROMPT_CHARS = 100_000;

/**
 * Cursor hook payload → a turn. Built from Cursor's hooks documentation, not yet confirmed in a real
 * Cursor run (see docs/hook-capture.md). It accepts two payload shapes, because it is not known which
 * one a hook declared on a skill receives:
 *
 *  - Claude-shaped: `session_id`, `last_assistant_message`, `transcript_path`, `cwd`.
 *  - Cursor-native: `conversation_id`, `generation_id`, `workspace_roots`, `transcript_path`, and per
 *    event: `beforeSubmitPrompt` → `prompt`, `afterAgentResponse` → `text`, `stop` → `status` only.
 *
 * Cursor splits a turn across events. `beforeSubmitPrompt` stashes the prompt in the session's state
 * and returns `null`; `afterAgentResponse` or `stop` pairs the reply with it. A `stop` carries no
 * reply, so that reply comes from the transcript. A reply with no prompt is still sent, without the
 * user half. A turn that was aborted or errored is not sent, and drops the prompt stashed for it.
 *
 * A reply taken from the transcript alone (a `stop`) is sent only if the transcript has moved past
 * what was already captured: its latest exchange's timestamp is not one already recorded (so a
 * transcript without timestamps cannot tell), and its latest prompt is the one stashed for this
 * generation, if one is stashed (compared after redaction, by prefix). Otherwise the transcript is
 * lagging, this event sends nothing (and says so in hook.log), and the hook would otherwise have
 * resent the previous turn under the new generation's id.
 *
 * Returns `null` for any other event or when there is nothing to send.
 */
export async function cursorTurn(input: HookInput): Promise<HookTurn | null> {
  const event = str(input.hook_event_name)?.toLowerCase();
  const sessionId = str(input.session_id) ?? str(input.conversation_id);
  if (!sessionId) {
    return null;
  }

  const generation = str(input.generation_id);
  if (event === 'beforesubmitprompt') {
    // Always replace the stash, so a blank or attachment-only prompt can't leave an older one to be attached to the wrong reply.
    const prompt = str(input.prompt);
    const state = await loadTurnState('cursor', sessionId);
    await saveTurnState('cursor', sessionId, {
      ...state,
      pendingPrompt: prompt ? cleanText(prompt, MAX_PENDING_PROMPT_CHARS) : undefined,
      pendingGeneration: prompt ? generation : undefined,
    });
    return null;
  }
  if (event !== undefined && event !== 'stop' && event !== 'afteragentresponse') {
    return null;
  }
  const status = str(input.status);
  if (status === 'aborted' || status === 'error') {
    const state = await loadTurnState('cursor', sessionId);
    if (state.pendingPrompt) {
      await saveTurnState('cursor', sessionId, { ...state, pendingPrompt: undefined, pendingGeneration: undefined });
    }
    return null;
  }

  let parsedExchanges: Exchange[] = [];
  let model: string | undefined;
  // `CURSOR_TRANSCRIPT_PATH` is the same path as an environment variable, per Cursor's hooks documentation (unverified).
  const transcriptPath = str(input.transcript_path) ?? str(process.env.CURSOR_TRANSCRIPT_PATH);
  if (transcriptPath) {
    try {
      const parsed = parseCursorExchanges((await readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)).toString('utf8'));
      parsedExchanges = parsed.exchanges;
      model = parsed.model;
    } catch {
      // Missing or unreadable transcript: fall through with whatever the payload itself carries.
    }
  }
  const tail = lastTurnFrom({ exchanges: parsedExchanges, model });

  const payloadText = str(input.last_assistant_message) ?? str(input.text);
  const assistantText = payloadText ?? tail.assistantText;
  if (!assistantText) {
    return null;
  }
  const state = await loadTurnState('cursor', sessionId);
  // A stash belongs to one user message: another generation's reply doesn't take it.
  const stashed = state.pendingPrompt && (!generation || !state.pendingGeneration || generation === state.pendingGeneration) ? state.pendingPrompt : undefined;
  if (!payloadText) {
    const latest = parsedExchanges[parsedExchanges.length - 1];
    const alreadyCaptured = !!latest?.timestamp && (state.captured ?? []).includes(latest.timestamp);
    // Like with like: the stash was redacted and capped when it was kept, so the transcript's prompt is too, and a prefix counts (a
    // transcript or a prompt that differs only by what was appended to it is still that prompt).
    const promptMismatch = !!stashed && !!tail.userText && !samePrompt(stashed, cleanText(tail.userText, MAX_PENDING_PROMPT_CHARS));
    if (alreadyCaptured || promptMismatch) {
      await logHookEvent(`capture-turn (cursor): ${alreadyCaptured ? 'the transcript shows only an exchange that was already sent' : "the transcript's latest prompt is not the one just submitted"} in ${sessionId}; the transcript has not caught up, so this event sends nothing.`);
      return null;
    }
  }

  // The transcript can lag the hook by exactly the reply. Only when it shows this turn is its latest
  // exchange this turn's; otherwise everything it holds is earlier history.
  const showsThisTurn = transcriptShowsThisTurn(tail, assistantText);
  const current = showsThisTurn ? parsedExchanges[parsedExchanges.length - 1] : undefined;
  // `earlierFrom` drops the last exchange, so a lagging transcript (whose last exchange is a previous turn) gets a placeholder after it.
  const shown: Exchange[] = showsThisTurn ? parsedExchanges : [...parsedExchanges, {}];

  const userText = (showsThisTurn ? tail.userText : undefined) ?? stashed;

  const workspaceRoots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];

  return {
    sessionId,
    userText,
    assistantText,
    model: model ?? str(input.model),
    // Cursor's id for the user message; it tells a repeated identical prompt from one event firing twice.
    turnKey: generation,
    cwd: str(input.cwd) ?? str(workspaceRoots[0]),
    exchangeTimestamp: current?.timestamp,
    earlier: earlierFrom(shown),
    earlierStamps: earlierStampsFrom(shown),
    ...(current ? splitCurrent(current.messages, assistantText) : {}),
  };
}

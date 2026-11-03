import { ExitCode } from '../errors.js';
import { PACKAGE_IDENTIFIER } from '../version.js';
import { ADAPTERS } from '../hooks/adapters/index.js';
import { skillMatches } from '../hooks/adapters/shared.js';
import { isCaptureDisabled } from '../hooks/disabled.js';
import { logHookEvent } from '../hooks/hook-log.js';
import { resolveTesterIdentity } from '../hooks/identity.js';
import { readHookInput } from '../hooks/stdin.js';
import { withSilencedConsole } from '../hooks/silence.js';
import { replaySpooledTurns, sendTurn } from '../hooks/send-turn.js';
import { digestTurn, loadTurnState, saveTurnState, withCaptured } from '../hooks/turn-state.js';
import type { HookInput, HookTurn } from '../hooks/types.js';
import { cleanText } from '../sessions/blocks.js';
import { buildTurnEnvelope, prepareTurnMessages } from '../sessions/turn-envelope.js';
import type { CaptureTurnOptions } from '../types.js';
import type { DeclaredContext } from 'coolhand-node';

/** Cap on the skill text kept in a session's state and sent as `system`. It is redacted before it is kept. */
const MAX_SKILL_TEXT_CHARS = 100_000;

/**
 * The text of the skill that is being captured: the body Claude Code injected when it was invoked,
 * found in the transcript at or after the session's anchor. The injected line names the skill by its
 * directory, so the one whose directory is called `skill` is the one. Never guessed without `--skill`.
 */
function findSkillText(turn: HookTurn, skill: string | undefined, anchor: string | undefined): string | undefined {
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
  if (!skill || Number.isNaN(anchorMs)) {
    return undefined;
  }
  for (const body of turn.skillBodies ?? []) {
    if (skillMatches(skill, body) && body.timestamp && Date.parse(body.timestamp) >= anchorMs) {
      return cleanText(body.text, MAX_SKILL_TEXT_CHARS);
    }
  }
  return undefined;
}

/** The workload this skill's logs belong to: one per skill, declared by key (the server find-or-creates it). */
function declaredWorkload(opts: CaptureTurnOptions): DeclaredContext | undefined {
  if (!opts.skill || opts.declare === false) {
    return undefined;
  }
  const skill = opts.skill.slice(0, 200);
  return { reporter: 'coolhand-cli', workload: { key: `${opts.agent}-skill:${skill}`, name: skill } };
}

export interface CaptureTurnDeps {
  /** Replaces reading the hook payload from stdin. Tests only. */
  readInput?: () => Promise<HookInput | null>;
}

/**
 * Hook entrypoint: send the turn an agent just finished to Coolhand. Reads the agent's hook JSON
 * from stdin, authenticates with a public API key given by `--api-key` or `COOLHAND_API_KEY` (no
 * stored login, no `--client-id`, never prompts), and sends the turn with the conversation so far
 * (prompts, thinking, tool calls and results, replies), redacted and capped. Per-session progress is kept so each turn is sent once.
 *
 * A hook must not disturb the agent that runs it, so this ALWAYS exits 0 and writes nothing to
 * stdout or stderr. Failures go to `~/.coolhand/capture-turns/hook.log`; turns that couldn't be sent
 * are spooled and retried.
 */
export async function run(opts: CaptureTurnOptions, deps: CaptureTurnDeps = {}): Promise<number> {
  try {
    await withSilencedConsole(() => capture(opts, deps));
  } catch (err) {
    await logHookEvent(`capture-turn (${opts.agent}) failed: ${(err as Error).message}`);
  }
  return ExitCode.OK;
}

async function capture(opts: CaptureTurnOptions, deps: CaptureTurnDeps): Promise<void> {
  // Kill switch for people who didn't choose to have a skill's hook running: nothing is read or sent.
  if (isCaptureDisabled()) {
    return;
  }
  const apiKey = opts.apiKey || process.env.COOLHAND_API_KEY;
  if (!apiKey) {
    await logHookEvent(`capture-turn (${opts.agent}): no API key (pass --api-key or set COOLHAND_API_KEY); nothing sent.`);
    return;
  }

  const input = await (deps.readInput ?? (() => readHookInput()))();
  if (!input) {
    return;
  }

  if (opts.agent === 'copilot' && !opts.skill) {
    await logHookEvent('capture-turn (copilot): --skill is required (a Copilot hook runs for every chat and sends only the skill\'s); nothing sent.');
    return;
  }
  const parsed: HookTurn | null = await ADAPTERS[opts.agent](input, { skill: opts.skill });
  if (!parsed) {
    return;
  }
  // --anonymous keeps the working directory (usually /Users/<name>/…) off the wire too.
  const turn: HookTurn = opts.anonymous ? { ...parsed, cwd: undefined } : parsed;

  const state = await loadTurnState(opts.agent, turn.sessionId);
  const digest = digestTurn(turn.userText, turn.assistantText, turn.turnKey);
  if (state.lastDigest === digest) {
    return;
  }
  const turnIndex = state.turnIndex + 1;

  // Resolved on the session's first turn and reused; --anonymous never reads or stores a cached identity.
  const tester =
    (!opts.anonymous && state.tester) || (await resolveTesterIdentity({ anonymous: opts.anonymous, cwd: parsed.cwd }));
  // The anchor is the first captured turn of the session. A session whose state carries none (but is
  // past turn 1) gets no history this turn, flagged, and starts one from here.
  const anchor = turnIndex > 1 ? state.anchor : turn.exchangeTimestamp;
  const seededLate = turnIndex > 1 && !state.anchor;
  const history = prepareTurnMessages(turn, turnIndex, anchor, new Set(state.captured ?? []));
  const skillText = state.skillText ?? findSkillText(turn, opts.skill, anchor ?? state.anchor);
  const envelope = buildTurnEnvelope(opts.agent, turn, turnIndex, digest, history, skillText);
  const outcome = await sendTurn(envelope, {
    apiKey,
    baseUrl: opts.baseUrl,
    collector: `${PACKAGE_IDENTIFIER}/hook-${opts.agent}`,
    session: turn.sessionId,
    turn: turnIndex,
    declared: declaredWorkload(opts),
    metadata: {
      session_id: turn.sessionId,
      turn_index: turnIndex,
      // The server does not dedup, so consumers can: this is the same id the log's response_body carries.
      turn_id: envelope.response_body.id,
      // The messages are the conversation so far; say when the oldest part of it had to be left out.
      ...(history.truncated || seededLate || state.anchorLate ? { history_truncated: true } : {}),
      ...(history.omitted > 0 ? { history_omitted: history.omitted } : {}),
      // What subagents spent, per model: kept apart because a log has one model and they run on others.
      ...(history.subagents ? { subagent_usage: history.subagents } : {}),
      agent: opts.agent,
      tester: tester.id,
      tester_source: tester.source,
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.skillVersion ? { skill_version: opts.skillVersion } : {}),
      ...(turn.cwd ? { project_path: turn.cwd } : {}),
    },
  });
  if (outcome === 'failed') {
    await logHookEvent(`capture-turn (${opts.agent}): turn ${turnIndex} of ${turn.sessionId} could not be sent or spooled and is lost.`);
  }
  if (outcome === 'spooled') {
    await logHookEvent(`capture-turn (${opts.agent}): turn ${turnIndex} of ${turn.sessionId} could not be sent; spooled for retry.`);
  }

  const anchorToSave = state.anchor ?? turn.exchangeTimestamp;
  try {
    await saveTurnState(opts.agent, turn.sessionId, {
      turnIndex,
      lastDigest: digest,
      ...(anchorToSave ? { anchor: anchorToSave } : {}),
      captured: withCaptured(state.captured, turn.exchangeTimestamp),
      ...(skillText ? { skillText } : {}),
      ...(seededLate || state.anchorLate ? { anchorLate: true } : {}),
      ...(opts.anonymous ? {} : { tester }),
    });
  } catch (err) {
    // The turn is already sent; say what is now off rather than losing the replay too.
    await logHookEvent(`capture-turn (${opts.agent}): could not save session state (${(err as Error).message}); turn numbering and double-fire protection are off for this session.`);
  }

  // Replay only after this turn's progress is on disk: if the agent kills the hook mid-replay, the
  // next turn must not reuse this turn's number.
  if (outcome === 'sent') {
    await replaySpooledTurns();
  }
}

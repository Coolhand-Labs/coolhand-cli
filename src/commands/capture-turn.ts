import { ExitCode } from '../errors.js';
import { PACKAGE_IDENTIFIER } from '../version.js';
import { claudeTurn } from '../hooks/adapters/claude.js';
import { isCaptureDisabled } from '../hooks/disabled.js';
import { logHookEvent } from '../hooks/hook-log.js';
import { resolveTesterIdentity } from '../hooks/identity.js';
import { readHookInput } from '../hooks/stdin.js';
import { withSilencedConsole } from '../hooks/silence.js';
import { replaySpooledTurns, sendTurn } from '../hooks/send-turn.js';
import { digestTurn, loadTurnState, saveTurnState } from '../hooks/turn-state.js';
import type { HookInput, HookTurn } from '../hooks/types.js';
import { buildTurnEnvelope } from '../sessions/turn-envelope.js';
import type { CaptureTurnOptions } from '../types.js';

export interface CaptureTurnDeps {
  /** Replaces reading the hook payload from stdin. Tests only. */
  readInput?: () => Promise<HookInput | null>;
}

/**
 * Hook entrypoint: send the turn an agent just finished to Coolhand. Reads the agent's hook JSON
 * from stdin, authenticates with a public API key given by `--api-key` or `COOLHAND_API_KEY` (no
 * stored login, no `--client-id`, never prompts), and sends only the user and assistant text of the
 * turn. Per-session progress is kept so each turn is sent once.
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

  const parsed: HookTurn | null = await claudeTurn(input);
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
  const envelope = buildTurnEnvelope(opts.agent, turn, turnIndex, digest);
  const outcome = await sendTurn(envelope, {
    apiKey,
    baseUrl: opts.baseUrl,
    collector: `${PACKAGE_IDENTIFIER}/hook-${opts.agent}`,
    metadata: {
      session_id: turn.sessionId,
      turn_index: turnIndex,
      // The server does not dedup, so consumers can: this is the same id the log's response_body carries.
      turn_id: envelope.response_body.id,
      agent: opts.agent,
      tester: tester.id,
      tester_source: tester.source,
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(turn.cwd ? { project_path: turn.cwd } : {}),
    },
  });
  if (outcome === 'failed') {
    await logHookEvent(`capture-turn (${opts.agent}): turn ${turnIndex} of ${turn.sessionId} could not be sent or spooled and is lost.`);
  }
  if (outcome === 'spooled') {
    await logHookEvent(`capture-turn (${opts.agent}): turn ${turnIndex} of ${turn.sessionId} could not be sent; spooled for retry.`);
  }

  try {
    await saveTurnState(opts.agent, turn.sessionId, { turnIndex, lastDigest: digest, ...(opts.anonymous ? {} : { tester }) });
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

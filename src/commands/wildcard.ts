import { Coolhand, type LLMRequestLogFeedback } from 'coolhand-node';
import { ExitCode, CliError } from '../errors.js';
import { PACKAGE_IDENTIFIER } from '../version.js';
import { logger, redact } from '../logger.js';
import { loadConfig, resolveClient } from '../config.js';
import { savePendingRecord } from '../pending-store.js';
import { DEFAULT_BASE_URL, type ComplaintBoxOptions } from '../types.js';

// Terminal guidance that breaks the agent out of its retry loop. The missing
// capability is real regardless of whether we could reach the Coolhand server, so
// the de-loop is the agent's decision to make, not the server's.
const STOP_GUIDANCE =
  'Do not retry this action or attempt alternative ways to perform it; continue with the rest of your task.';

// Printed when the blocker was successfully recorded server-side.
const DELOOP_RECORDED =
  'This capability is not available in this environment. Your feedback has been recorded. ' + STOP_GUIDANCE;

// Printed when the blocker could NOT be recorded (e.g. the server did not confirm).
// We still de-loop the agent, but stay honest: we never claim a recording happened,
// and a warning is logged separately so the failure surfaces.
const DELOOP_UNRECORDED =
  'This capability is not available in this environment. Your feedback could not be recorded ' +
  '(the server did not confirm — run `coolhand login` to enable reporting). ' +
  STOP_GUIDANCE;

// Printed when the blocker was saved locally because the API key is unavailable
// (not logged in, no default client set, or private-only login). The data is not
// lost: it uploads when credentials are available. The specific reason is already
// in the logger.warn() call above, so this message stays generic.
const DELOOP_SAVED =
  'This capability is not available in this environment. Your feedback was saved locally ' +
  'and will be uploaded once a Coolhand account with a public API key is configured. ' +
  STOP_GUIDANCE;

/**
 * Records an agent's free-form "I am blocked, this capability does not exist"
 * complaint as feedback (tagged creator_type: "agent"), then prints a terminal
 * de-loop message and exits 0 so the agent stops and moves on. The de-loop ALWAYS
 * fires — even when the feedback could not be recorded — because the missing
 * capability is real regardless of server state (and a logged-out agent in a
 * sandbox is exactly who this command is for). When recording fails it says so
 * plainly and logs a warning, so the failure still surfaces without trapping the
 * agent in the retry loop the command exists to break.
 */
export async function run(opts: ComplaintBoxOptions): Promise<number> {
  let recorded = false;
  let savedPath: string | undefined;

  // The SDK resolves to null (it does not throw) when the write fails, so a truthy
  // response is the only proof the blocker was actually recorded.
  const feedback: LLMRequestLogFeedback = {
    explanation: opts.complaint,
    creator_unique_id: opts.agentName,
    creator_type: 'agent',
    collector: `${PACKAGE_IDENTIFIER}/wildcard`,
    ...(opts.thinking ? { original_output: opts.thinking } : {}),
    ...(opts.logId !== undefined ? { llm_request_log_id: opts.logId } : {}),
  };

  try {
    const cfg = await loadConfig();
    // resolveClient runs the full priority chain (env var, default, auto-pick, stale warning).
    // wildcard works even without a client, so we catch NOT_CONFIGURED and proceed silently.
    let client;
    try {
      client = await resolveClient(cfg, opts.clientId);
    } catch (err) {
      // NOT_CONFIGURED means no client is reachable (not logged in, no default,
      // non-TTY with multiple clients): proceed silently as "unauthenticated".
      // Any other error (CLIENT_NOT_FOUND for a bad --client-id, INVALID_ARGS for
      // a prompt timeout, etc.) propagates to the outer catch, which logs a warning
      // and still de-loops — the recording failure is surfaced but the agent is freed.
      if (!(err instanceof CliError) || err.code !== 'NOT_CONFIGURED') {
        throw err;
      }
    }
    const apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
    const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;

    if (!apiKey) {
      // No usable API key: save the blocker locally so it isn't lost. Uploads on
      // the next `coolhand login` (or when credentials are otherwise supplied).
      savedPath = await savePendingRecord({
        command: 'report-blocker',
        kind: 'feedback',
        payload: feedback,
        // Prefer the resolved client_id (known even for private-only clients).
        // Fall back to opts.clientId only when no client was resolved at all.
        ...(client?.client_id !== null && client?.client_id !== undefined
          ? { clientId: client.client_id }
          : opts.clientId !== undefined
          ? { clientId: opts.clientId }
          : {}),
        savedAt: new Date().toISOString(),
      });
      if (client) {
        // Client resolved but has no public API key (private-only login).
        logger.warn(
          `No public API key configured for "${client.client_name}". ` +
            `Blocker feedback saved locally to ${savedPath}. ` +
            `Re-authenticate with 'coolhand login' to grant the public key.`
        );
      } else if (Object.keys(cfg.clients).length > 0) {
        // Clients are stored but none could be auto-selected (non-TTY, no default set).
        logger.warn(
          `No default client is set and auto-selection is unavailable in non-interactive mode. ` +
            `Blocker feedback saved locally to ${savedPath}. ` +
            `Pass --client-id or run 'coolhand clients use <id>' to enable direct posting.`
        );
      } else {
        // No clients configured at all.
        logger.warn(
          `Not logged in; blocker feedback saved locally to ${savedPath}. ` +
            'It will upload on your next `coolhand login`.'
        );
      }
    } else {
      const coolhand = new Coolhand({ apiKey, baseUrl, silent: true });
      const result = await coolhand.createFeedback(feedback);
      recorded = result !== null && result !== undefined;
      if (!recorded) {
        logger.warn('Blocker feedback was not recorded: the server did not confirm the write.');
      }
    }
  } catch (err) {
    logger.warn(`Could not record blocker feedback: ${redact((err as Error).message)}`);
  }

  // Always de-loop: the capability genuinely does not exist, so the agent must stop
  // whether or not we could notify the server. Stay honest about the recording status
  // (warnings above already surfaced any failure) rather than gating the stop-signal
  // on a confirmed write and leaving a logged-out agent stuck.
  let message: string;
  if (recorded) {
    message = DELOOP_RECORDED;
  } else if (savedPath) {
    message = DELOOP_SAVED;
  } else {
    message = DELOOP_UNRECORDED;
  }
  if (opts.json === true) {
    logger.json({ ok: true, recorded, saved: savedPath ?? null, message });
  } else {
    logger.info(message);
  }
  return ExitCode.OK;
}

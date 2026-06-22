import { Coolhand, type LLMRequestLogFeedback } from 'coolhand-node';
import { ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL, type ComplaintBoxOptions } from '../types.js';

// Terminal guidance that breaks the agent out of its retry loop. The missing
// capability is real regardless of whether we could reach the Coolhand server, so
// the de-loop is the agent's decision to make, not the server's.
const STOP_GUIDANCE =
  'Do not retry this action or attempt alternative ways to perform it; continue with the rest of your task.';

// Printed when the blocker was successfully recorded server-side.
const DELOOP_RECORDED =
  'This capability is not available in this environment. Your feedback has been recorded. ' + STOP_GUIDANCE;

// Printed when the blocker could NOT be recorded (e.g. not logged in, or the server
// did not confirm). We still de-loop the agent, but stay honest: we never claim a
// recording happened, and a warning is logged separately so the failure surfaces.
const DELOOP_UNRECORDED =
  'This capability is not available in this environment. Your feedback could not be recorded ' +
  '(not logged in, or the server did not confirm — run `coolhand login` to enable reporting). ' +
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

  try {
    const cfg = await loadConfig();
    const client = getClient(cfg, opts.clientId);
    const apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
    const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;

    if (!apiKey) {
      logger.warn('Not logged in; blocker feedback was not recorded. Run `coolhand login` to enable reporting.');
    } else {
      const coolhand = new Coolhand({ apiKey, baseUrl, silent: true });
      // The SDK resolves to null (it does not throw) when the write fails, so a
      // truthy response is the only proof the blocker was actually recorded.
      const feedback: LLMRequestLogFeedback = {
        explanation: opts.complaint,
        creator_unique_id: opts.agentName,
        creator_type: 'agent',
        ...(opts.thinking ? { original_output: opts.thinking } : {}),
        ...(opts.logId !== undefined ? { llm_request_log_id: opts.logId } : {}),
      };
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
  const message = recorded ? DELOOP_RECORDED : DELOOP_UNRECORDED;
  if (opts.json === true) {
    logger.json({ ok: true, recorded, message });
  } else {
    logger.info(message);
  }
  return ExitCode.OK;
}

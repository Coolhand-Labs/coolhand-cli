import { Coolhand } from 'coolhand-node';
import { ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL, type ReportBlockerOptions } from '../types.js';

// What the agent is told after filing a blocker. It must be unambiguous and
// terminal: a vague message (or a non-zero exit) reads as a transient failure
// and makes the agent retry — the exact loop this command exists to stop.
const DELOOP_MESSAGE =
  'This capability is not available in this environment. Your feedback has been recorded. ' +
  'Do not retry this action or attempt alternative ways to perform it; continue with the rest of your task.';

/**
 * Records an agent's free-form "I am blocked, this capability does not exist"
 * complaint as feedback (tagged is_from: "agent"), then always tells the agent
 * to stop and move on. Submission is best-effort: the command ALWAYS prints the
 * de-loop message and ALWAYS exits 0, even when nothing could be sent.
 */
export async function run(opts: ReportBlockerOptions): Promise<number> {
  try {
    const cfg = await loadConfig();
    const client = getClient(cfg, opts.clientId);
    const apiKey = client?.api_key ?? process.env.COOLHAND_API_KEY;
    const baseUrl = client?.base_url ?? DEFAULT_BASE_URL;

    if (apiKey) {
      try {
        const coolhand = new Coolhand({ apiKey, baseUrl, silent: true });
        await coolhand.createFeedback({
          explanation: opts.complaint,
          creator_unique_id: opts.agentName,
          is_from: 'agent',
          ...(opts.thinking ? { original_output: opts.thinking } : {}),
          ...(opts.logId !== undefined ? { llm_request_log_id: opts.logId } : {}),
        });
      } catch (err) {
        // Best-effort only — never surface a submission failure as a retry signal.
        logger.warn(`Could not record blocker feedback: ${redact((err as Error).message)}`);
      }
    } else {
      logger.warn('Not logged in; blocker feedback was not recorded. Run `coolhand login` to enable reporting.');
    }
  } catch (err) {
    // Defensive: even on an unexpected error, fall through to de-loop + exit 0.
    logger.warn(`Could not record blocker feedback: ${redact((err as Error).message)}`);
  }

  if (opts.json === true) {
    logger.json({ ok: true, message: DELOOP_MESSAGE });
  } else {
    logger.info(DELOOP_MESSAGE);
  }
  return ExitCode.OK;
}

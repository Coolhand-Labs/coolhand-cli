import { Coolhand, type LLMRequestLogFeedback } from 'coolhand-node';
import { ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL, type ReportBlockerOptions } from '../types.js';

// What the agent is told once the blocker is CONFIRMED recorded. It must be
// unambiguous and terminal so the agent stops retrying the missing capability.
// Printed only on a confirmed write — a failed submission exits non-zero instead,
// so it surfaces rather than being masked by a reassuring "recorded" message.
const DELOOP_MESSAGE =
  'This capability is not available in this environment. Your feedback has been recorded. ' +
  'Do not retry this action or attempt alternative ways to perform it; continue with the rest of your task.';

/**
 * Records an agent's free-form "I am blocked, this capability does not exist"
 * complaint as feedback (tagged creator_type: "agent"). On a confirmed write it prints
 * the de-loop message and exits 0 so the agent stops and moves on. If the write
 * cannot be confirmed (not logged in, or the server did not accept it), it warns
 * and exits non-zero so the failure surfaces instead of being silently swallowed.
 */
export async function run(opts: ReportBlockerOptions): Promise<number> {
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
      // coolhand-node 0.6.0's published type does not declare creator_type (it is
      // added in 0.7.0). The SDK forwards unknown fields to the API as-is, so we
      // send it now and widen the type locally. Drop this widening once the
      // dependency is bumped to coolhand-node ^0.7.0.
      const feedback: LLMRequestLogFeedback & { creator_type?: 'human' | 'agent' | 'unknown' } = {
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

  if (!recorded) {
    // Do not print the de-loop until the write is confirmed: a failed submission
    // must surface, not be hidden behind a reassuring "recorded" message.
    return ExitCode.INTERNAL;
  }

  if (opts.json === true) {
    logger.json({ ok: true, message: DELOOP_MESSAGE });
  } else {
    logger.info(DELOOP_MESSAGE);
  }
  return ExitCode.OK;
}

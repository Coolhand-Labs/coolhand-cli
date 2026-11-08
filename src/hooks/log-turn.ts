import { withContext, type Coolhand, type CoolhandCallData, type CoolhandLogResponse, type DeclaredContext } from 'coolhand-node';
import { logHookEvent } from './hook-log.js';

export interface LogTurnOptions {
  collector?: string;
  metadata: Record<string, unknown>;
  /**
   * The workload this log belongs to, sent as `llm_request_log.declared`. The server find-or-creates
   * the workload by key and attaches the log directly, skipping its own matching. Only a workload is
   * declared: no template (the server derives the skill's single default template from the workload).
   */
  declared?: DeclaredContext;
}

/** Longest server warning written to hook.log, and how many. */
const MAX_WARNINGS = 5;
const MAX_WARNING_CHARS = 300;

function warningText(warning: unknown): string {
  const text = warning && typeof warning === 'object' && 'message' in warning ? String((warning as { message: unknown }).message) : String(warning);
  return text.slice(0, MAX_WARNING_CHARS);
}

/**
 * Send one turn through the SDK, declared as `opts.declared` when given. Both the live send and the
 * replay of a spooled turn go through here, so a replay is declared exactly like the original.
 *
 * - `withContext` throws synchronously for a malformed declaration (a blank, over-long or control-
 *   character key, say). That must not cost the turn: it is written to hook.log and the turn is sent
 *   undeclared, so it still lands, just unmatched.
 * - The server answers `warnings` when it ignores a declaration (for example the public-key cap on
 *   declared workloads): the turn still landed, but not as declared. They go to hook.log.
 */
export async function logTurn(coolhand: Coolhand, envelope: unknown, opts: LogTurnOptions): Promise<CoolhandLogResponse | null> {
  let started = false;
  const send = (): Promise<CoolhandLogResponse | null> => {
    started = true;
    return coolhand.logRequest(envelope as CoolhandCallData, { collector: opts.collector, metadata: opts.metadata });
  };

  let result: CoolhandLogResponse | null;
  try {
    result = await (opts.declared ? withContext(opts.declared, send) : send());
  } catch (err) {
    if (!opts.declared || started) {
      return null;
    }
    await logHookEvent(`capture-turn: the workload declaration was rejected (${(err as Error).message}); sending the turn undeclared.`);
    try {
      result = await send();
    } catch {
      return null;
    }
  }

  const warnings = result && Array.isArray(result.warnings) ? result.warnings.slice(0, MAX_WARNINGS).map(warningText) : [];
  if (warnings.length > 0) {
    await logHookEvent(`capture-turn: the server accepted the turn with warnings: ${warnings.join(' | ')}`);
  }
  return result;
}

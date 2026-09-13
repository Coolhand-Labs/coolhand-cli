import type { LlmRequestTemplateDetail } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getTemplateClient, mapTemplateHttpError } from '../api/template-client.js';
import type { GetTemplateOptions } from '../types.js';

const TIMEOUT_HINT = 'It is retryable — try again shortly.';

const SUMMARY_FIELDS: Array<{ key: keyof LlmRequestTemplateDetail; label: string }> = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'version', label: 'Version' },
  { key: 'group', label: 'Group' },
  { key: 'workload_name', label: 'Workload' },
  { key: 'workload_id', label: 'Workload ID' },
  { key: 'system_template', label: 'System template' },
  { key: 'deprecated_at', label: 'Deprecated at' },
  { key: 'log_count', label: 'Log count' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
];

function printSummary(t: LlmRequestTemplateDetail): void {
  for (const { key, label } of SUMMARY_FIELDS) {
    const v = t[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      logger.info(`${label}: ${v}`);
    }
  }
  // Printed in full rather than truncated: a partial regex is misleading, and `logger.info`
  // already strips ANSI escapes from server-supplied text before it reaches the terminal.
  if (t.user_prompt_pattern) {
    logger.info(`\nUser Prompt Pattern\n-------------------\n${t.user_prompt_pattern}`);
  }
  if (t.system_prompt_pattern) {
    logger.info(`\nSystem Prompt Pattern\n---------------------\n${t.system_prompt_pattern}`);
  }
}

export async function run(opts: GetTemplateOptions): Promise<number> {
  try {
    const coolhand = await getTemplateClient({ clientId: opts.clientId });

    let result: LlmRequestTemplateDetail;
    try {
      result = await coolhand.getTemplate(opts.id);
    } catch (err) {
      throw mapTemplateHttpError(
        err,
        `Template "${opts.id}" not found (or does not belong to this client).`,
        TIMEOUT_HINT
      );
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      printSummary(result);
    }
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CliError) {
      if (opts.json) {
        logger.json({ ok: false, error: err.code, message: redact(err.message) });
      } else {
        logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      }
      return err.exitCode;
    }
    throw err;
  }
}

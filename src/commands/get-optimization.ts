import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { GetOptimizationOptions } from '../types.js';

export async function run(opts: GetOptimizationOptions): Promise<number> {
  try {
    const result = await mcpCall('get_optimization', { optimization_id: opts.id }, { clientId: opts.clientId });

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const r = result as Record<string, unknown>;
      const { coding_prompt, ...rest } = r;
      logger.info(JSON.stringify(rest, null, 2));
      if (typeof r.pr_number === 'number' && typeof r.pr_url === 'string') {
        logger.info(`PR: #${r.pr_number} ${r.pr_url}`);
      }
      if (typeof coding_prompt === 'string') {
        logger.info(`\n--- Coding Prompt ---\n${coding_prompt}`);
      }
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

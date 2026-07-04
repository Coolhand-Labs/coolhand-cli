import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { CloseOptimizationOptions } from '../types.js';

export async function run(opts: CloseOptimizationOptions): Promise<number> {
  try {
    const result = await mcpCall('close_optimization', { id: opts.id, explanation: opts.reason }, { clientId: opts.clientId });

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      logger.info(JSON.stringify(result, null, 2));
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

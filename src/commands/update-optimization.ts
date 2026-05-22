import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { UpdateOptimizationOptions } from '../types.js';

export async function run(opts: UpdateOptimizationOptions): Promise<number> {
  try {
    const args: Record<string, unknown> = { id: opts.id };
    if (opts.title !== undefined) {
      args.title = opts.title;
    }
    if (opts.analysis !== undefined) {
      args.analysis = opts.analysis;
    }
    if (opts.plan !== undefined) {
      args.plan = opts.plan;
    }

    const result = await mcpCall('update_optimization', args, { clientId: opts.clientId });

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

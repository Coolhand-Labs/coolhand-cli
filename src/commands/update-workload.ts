import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { UpdateWorkloadOptions } from '../types.js';

export async function run(opts: UpdateWorkloadOptions): Promise<number> {
  try {
    const args: Record<string, unknown> = { workload_id: opts.id };
    if (opts.name !== undefined) {
      args.name = opts.name;
    }
    if (opts.description !== undefined) {
      args.description = opts.description;
    }

    const result = await mcpCall('update_workload', args, { clientId: opts.clientId });

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

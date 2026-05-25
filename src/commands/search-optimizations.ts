import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { SearchOptimizationsOptions } from '../types.js';

export async function run(opts: SearchOptimizationsOptions): Promise<number> {
  try {
    const args: Record<string, unknown> = {};
    if (opts.status !== undefined) {
      args.status = opts.status;
    }
    if (opts.type !== undefined) {
      args.type = opts.type;
    }
    if (opts.category !== undefined) {
      args.category = opts.category;
    }
    if (opts.query !== undefined) {
      args.query = opts.query;
    }
    if (opts.from !== undefined) {
      args.from = opts.from;
    }
    if (opts.to !== undefined) {
      args.to = opts.to;
    }

    const result = await mcpCall('search_optimizations', args, { clientId: opts.clientId });

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

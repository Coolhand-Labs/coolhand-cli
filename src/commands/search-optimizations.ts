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
    if (opts.page !== undefined) {
      args.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      args.per_page = opts.perPage;
    }
    if (opts.templateId !== undefined) {
      args.template_id = opts.templateId;
    }
    if (opts.workloadId !== undefined) {
      args.workload_id = opts.workloadId;
    }
    if (opts.daysBack !== undefined) {
      args.days_back = opts.daysBack;
    }
    if (opts.sortBy !== undefined) {
      args.sort_by = opts.sortBy;
    }

    const result = await mcpCall('search_optimizations', args, { clientId: opts.clientId });

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const r = result as Record<string, unknown>;
      if (r && typeof r.total === 'number' && typeof r.page === 'number') {
        const perPage = typeof r.per_page === 'number' ? r.per_page : 20;
        const totalPages = Math.ceil(r.total / perPage);
        logger.info(`Page ${r.page} of ${totalPages} (${r.total} total) — use --page N to navigate`);
      }
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

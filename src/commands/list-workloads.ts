import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { ListWorkloadsOptions } from '../types.js';

export async function run(opts: ListWorkloadsOptions): Promise<number> {
  try {
    const args: Record<string, unknown> = {};
    if (opts.search !== undefined) {
      args.search = opts.search;
    }
    if (opts.page !== undefined) {
      args.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      args.per_page = opts.perPage;
    }
    if (opts.includeArchived === true) {
      args.include_archived = true;
    }
    if (opts.includeSystem === true) {
      args.include_system = true;
    }
    if (opts.includeTemplates === true) {
      args.include_templates = true;
    }

    const result = await mcpCall('list_workloads', args, { clientId: opts.clientId });

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const r = result as Record<string, unknown>;
      if (r && typeof r.total === 'number' && typeof r.page === 'number' && typeof r.per_page === 'number') {
        const totalPages = Math.ceil(r.total / r.per_page);
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

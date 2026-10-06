import type { SearchWorkloadsParams, SearchWorkloadsResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getWorkloadClient, mapWorkloadHttpError } from '../api/workload-client.js';
import { metricsLines, metricsWindowParams } from '../cost-format.js';
import type { SearchWorkloadsOptions } from '../types.js';

export async function run(opts: SearchWorkloadsOptions): Promise<number> {
  try {
    const coolhand = await getWorkloadClient({ clientId: opts.clientId });

    const params: SearchWorkloadsParams = metricsWindowParams(opts);
    if (opts.search !== undefined) {
      params.search = opts.search;
    }
    if (opts.includeArchived) {
      params.includeArchived = true;
    }
    if (opts.includeSystem) {
      params.includeSystem = true;
    }
    if (opts.includeTemplates) {
      params.includeTemplates = true;
    }
    if (opts.includeMetrics) {
      params.includeMetrics = true;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: SearchWorkloadsResponse;
    try {
      result = await coolhand.searchWorkloads(params);
    } catch (err) {
      throw mapWorkloadHttpError(err);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { pagination } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
      for (const w of result.workloads) {
        logger.info(`${w.id}  ${w.name}  templates: ${w.template_count}  logs: ${w.log_count}`);
        if (w.metrics) {
          for (const line of metricsLines(w.metrics)) {
            logger.info(`  ${line}`);
          }
        }
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

import type { ListStepTemplatesParams, ListStepTemplatesResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getTemplateClient } from '../api/template-client.js';
import { mapStepTemplateHttpError } from '../api/step-template-client.js';
import type { ListStepTemplatesOptions } from '../types.js';

const TIMEOUT_HINT = 'Narrow it with --search or a smaller --per-page, then retry.';

export async function run(opts: ListStepTemplatesOptions): Promise<number> {
  try {
    const coolhand = await getTemplateClient({ clientId: opts.clientId });

    const params: ListStepTemplatesParams = {};
    if (opts.search !== undefined) {
      params.search = opts.search;
    }
    if (opts.stepType !== undefined) {
      params.stepType = opts.stepType;
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

    let result: ListStepTemplatesResponse;
    try {
      result = await coolhand.listStepTemplates(params);
    } catch (err) {
      throw mapStepTemplateHttpError(err, 'Step template list failed.', TIMEOUT_HINT);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { pagination } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
      if (opts.includeMetrics && opts.perPage !== undefined && pagination.per_page < opts.perPage) {
        logger.info(`--include-metrics caps the page size at ${pagination.per_page}; ${opts.perPage} was requested.`);
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

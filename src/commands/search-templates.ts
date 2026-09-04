import type { SearchTemplatesParams, SearchTemplatesResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getTemplateClient, mapTemplateHttpError } from '../api/template-client.js';
import type { SearchTemplatesOptions } from '../types.js';

const TIMEOUT_HINT =
  'Narrow it with --workload-id, --search, or a smaller --per-page, then retry.';

export async function run(opts: SearchTemplatesOptions): Promise<number> {
  try {
    const coolhand = await getTemplateClient({ clientId: opts.clientId });

    const params: SearchTemplatesParams = {};
    if (opts.search !== undefined) {
      params.search = opts.search;
    }
    if (opts.workloadId !== undefined) {
      params.workloadId = opts.workloadId;
    }
    if (opts.status !== undefined) {
      params.status = opts.status;
    }
    if (opts.includeDeprecated) {
      params.includeDeprecated = true;
    }
    if (opts.includeSystem) {
      params.includeSystem = true;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: SearchTemplatesResponse;
    try {
      result = await coolhand.searchTemplates(params);
    } catch (err) {
      throw mapTemplateHttpError(err, 'Template search failed.', TIMEOUT_HINT);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { pagination } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
      if (result.templates.length === 0 && !opts.includeSystem) {
        logger.info(
          'No templates matched. The Unmatched and Ignored API Calls system buckets are hidden by default — pass --include-system to include them.'
        );
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

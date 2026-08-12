import type { SearchLogsParams, SearchLogsResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getLogClient, mapLogHttpError } from '../api/log-client.js';
import type { SearchLogsOptions } from '../types.js';

export async function run(opts: SearchLogsOptions): Promise<number> {
  try {
    const coolhand = await getLogClient({ clientId: opts.clientId });

    const params: SearchLogsParams = {};
    if (opts.templateId !== undefined) {
      params.templateId = opts.templateId;
    }
    if (opts.workloadId !== undefined) {
      params.workloadId = opts.workloadId;
    }
    if (opts.systemPromptContains !== undefined) {
      params.systemPromptContains = opts.systemPromptContains;
    }
    if (opts.userPromptContains !== undefined) {
      params.userPromptContains = opts.userPromptContains;
    }
    if (opts.model !== undefined) {
      params.model = opts.model;
    }
    if (opts.sourceApi !== undefined) {
      params.sourceApi = opts.sourceApi;
    }
    if (opts.sourceApiResult !== undefined) {
      params.sourceApiResult = opts.sourceApiResult;
    }
    if (opts.unmatchedOnly) {
      params.unmatchedOnly = true;
    }
    if (opts.daysBack !== undefined) {
      params.daysBack = opts.daysBack;
    }
    if (opts.includePrompts) {
      params.includePrompts = true;
    }
    if (opts.sort !== undefined) {
      params.sort = opts.sort;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: SearchLogsResponse;
    try {
      result = await coolhand.searchLogs(params);
    } catch (err) {
      throw mapLogHttpError(err, 'Log search failed.');
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { pagination } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
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

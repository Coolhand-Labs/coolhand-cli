import type { ListReferencedFileSessionsParams, ListReferencedFileSessionsResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getLlmReferenceClient, mapLlmReferenceHttpError } from '../api/llm-reference-client.js';
import type { ListReferencedFileSessionsOptions } from '../types.js';

export async function run(opts: ListReferencedFileSessionsOptions): Promise<number> {
  try {
    const coolhand = await getLlmReferenceClient({ clientId: opts.clientId });

    const params: ListReferencedFileSessionsParams = { filePath: opts.filePath };
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: ListReferencedFileSessionsResponse;
    try {
      result = await coolhand.listReferencedFileSessions(params);
    } catch (err) {
      throw mapLlmReferenceHttpError(err);
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

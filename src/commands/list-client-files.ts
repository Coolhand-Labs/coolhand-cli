import type { ListClientFilesParams, ListClientFilesResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getClientFileClient, mapClientFileHttpError } from '../api/client-file-client.js';
import type { ListClientFilesOptions } from '../types.js';

export async function run(opts: ListClientFilesOptions): Promise<number> {
  try {
    const coolhand = await getClientFileClient({ clientId: opts.clientId });

    const params: ListClientFilesParams = {};
    if (opts.status !== undefined) {
      params.status = opts.status;
    }
    if (opts.fileType !== undefined) {
      params.fileType = opts.fileType;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: ListClientFilesResponse;
    try {
      result = await coolhand.listClientFiles(params);
    } catch (err) {
      throw mapClientFileHttpError(err, 'Client files not found.');
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { pagination, files } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
      if (files.length === 0) {
        logger.info('No client files matched.');
      }
      for (const f of files) {
        logger.info(`${f.id}  ${f.status}  ${f.file_type}  ${f.name}`);
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

import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { uploadClientFile } from '../upload-client-file.js';
import type { UploadClientFileOptions } from '../types.js';

export async function run(opts: UploadClientFileOptions): Promise<number> {
  try {
    const result = await uploadClientFile(
      {
        filePath: opts.filePath,
        name: opts.name,
        fileType: opts.fileType,
        description: opts.description,
      },
      { clientId: opts.clientId, dryRun: opts.dryRun }
    );

    const mb = (result.sizeBytes / (1024 * 1024)).toFixed(2);

    if (opts.json) {
      logger.json({
        ok: true,
        dryRun: result.status === 'dry-run',
        sizeBytes: result.sizeBytes,
        result: result.response,
      });
    } else if (result.status === 'dry-run') {
      logger.info(`Dry run: would upload "${opts.filePath}" (${mb}MB). Nothing sent.`);
    } else {
      logger.info(
        `Uploaded "${opts.filePath}" (${mb}MB) as client file "${result.response?.name}" ` +
          `(id: ${result.response?.id}, status: ${result.response?.status}).`
      );
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

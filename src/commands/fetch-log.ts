import type { GetLogContentOptions, LlmRequestLogContent } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getLogClient, mapLogHttpError } from '../api/log-client.js';
import type { FetchLogOptions } from '../types.js';

export async function run(opts: FetchLogOptions): Promise<number> {
  try {
    const coolhand = await getLogClient({ clientId: opts.clientId });

    let contentOpts: GetLogContentOptions;
    if (opts.searchQuery !== undefined) {
      contentOpts = { searchQuery: opts.searchQuery, includeThinking: opts.includeThinking };
    } else {
      contentOpts = { section: opts.section, maxChars: opts.maxChars, includeThinking: opts.includeThinking };
    }

    let result: LlmRequestLogContent;
    try {
      result = await coolhand.getLogContent(opts.logId, contentOpts);
    } catch (err) {
      throw mapLogHttpError(err, `Log "${opts.logId}" not found (or does not belong to this client).`);
    }

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

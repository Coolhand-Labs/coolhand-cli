import type { CoolhandClientFileResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getClientFileClient, mapClientFileHttpError } from '../api/client-file-client.js';
import type { UpdateClientFileOptions } from '../types.js';

export async function run(opts: UpdateClientFileOptions): Promise<number> {
  try {
    const coolhand = await getClientFileClient({ clientId: opts.clientId });

    let result: CoolhandClientFileResponse | null;
    try {
      result = await coolhand.updateClientFileStatus(opts.id, opts.status);
    } catch (err) {
      throw mapClientFileHttpError(err, `Client file "${opts.id}" not found (or does not belong to this client).`);
    }
    if (result === null) {
      // updateClientFileStatus only resolves to null in the SDK's dryRun mode, which the CLI never enables.
      throw new CliError('CLIENT_FILE_ERROR', `Client file "${opts.id}" was not updated: no response received.`);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      logger.info(`Client file "${result.name}" (id: ${result.id}) is now ${result.status}.`);
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

import type { RealizedSavings } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getTemplateClient } from '../api/template-client.js';
import { mapSavingsHttpError } from '../api/savings-client.js';
import { formatCost } from '../format-cost.js';
import type { GetRealizedSavingsOptions } from '../types.js';

export async function run(opts: GetRealizedSavingsOptions): Promise<number> {
  try {
    const coolhand = await getTemplateClient({ clientId: opts.clientId });

    let result: RealizedSavings;
    try {
      result = await coolhand.getRealizedSavings();
    } catch (err) {
      throw mapSavingsHttpError(err);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      logger.info(`Realized savings: ${formatCost(result.total)} (${result.percent}%)`);
      logger.info(`Cost at previous versions: ${formatCost(result.cost_at_previous_versions)}`);
      for (const w of result.workloads) {
        logger.info(
          `${w.id}  ${w.name}  saved ${formatCost(w.savings)} of ${formatCost(w.cost_at_previous_versions)}  (${w.active_requests} active requests)`
        );
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

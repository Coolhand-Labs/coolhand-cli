import type { GetLogContentOptions, LlmRequestLogContent, LlmRequestLogTurnMetric } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getLogClient, mapLogHttpError } from '../api/log-client.js';
import { formatCost } from '../format-cost.js';
import type { FetchLogOptions } from '../types.js';

function printTurnMetrics(turns: LlmRequestLogTurnMetric[] | null | undefined): void {
  if (turns === undefined) {
    logger.info('Turn metrics: not returned by the server');
    return;
  }
  if (turns === null) {
    logger.info('Turn metrics: n/a (not a captured agent session)');
    return;
  }
  logger.info('Turn metrics:');
  for (const t of turns) {
    const tokens = (n: number | null) => (n === null ? 'n/a' : String(n));
    logger.info(
      `  #${t.index} ${t.human ? 'human' : 'automated'}: ${t.assistant_requests} requests, ${t.tool_calls} tool calls, ` +
        `tokens ${tokens(t.input_tokens)} in / ${tokens(t.output_tokens)} out ` +
        `(cache ${tokens(t.cache_read_tokens)} read / ${tokens(t.cache_creation_tokens)} created)`
    );
  }
}

export async function run(opts: FetchLogOptions): Promise<number> {
  try {
    const coolhand = await getLogClient({ clientId: opts.clientId });

    let contentOpts: GetLogContentOptions;
    if (opts.searchQuery !== undefined) {
      contentOpts = {
        searchQuery: opts.searchQuery,
        includeThinking: opts.includeThinking,
        includeTurnMetrics: opts.includeTurnMetrics,
      };
    } else {
      contentOpts = {
        section: opts.section,
        maxChars: opts.maxChars,
        includeThinking: opts.includeThinking,
        includeTurnMetrics: opts.includeTurnMetrics,
      };
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
      if ('cost' in result) {
        logger.info(`Cost: ${formatCost(result.cost)}`);
        if (result.cost_breakdown) {
          for (const [key, value] of Object.entries(result.cost_breakdown)) {
            logger.info(`  ${key}: ${formatCost(value)}`);
          }
        }
      }
      if (opts.includeTurnMetrics) {
        printTurnMetrics(result.turn_metrics);
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

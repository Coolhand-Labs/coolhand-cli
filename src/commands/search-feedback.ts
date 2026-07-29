import type { SearchFeedbackParams, SearchFeedbackResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getFeedbackClient, mapFeedbackHttpError } from '../api/feedback-client.js';
import type { SearchFeedbackOptions } from '../types.js';

/** `sentiment` is stored server-side as an integer code (0=dislike, 1=neutral, 2=like); Ransack's
 *  `sentiment_eq` predicate takes that raw code, not the string label. */
const SENTIMENT_CODES = { negative: 0, neutral: 1, positive: 2 } as const;

export async function run(opts: SearchFeedbackOptions): Promise<number> {
  try {
    const coolhand = await getFeedbackClient({ clientId: opts.clientId });

    const params: SearchFeedbackParams = {};
    if (opts.sentiment !== undefined) {
      params.sentiment_eq = SENTIMENT_CODES[opts.sentiment];
    }
    if (opts.search !== undefined) {
      params.explanation_cont = opts.search;
    }
    if (opts.creatorId !== undefined) {
      params.creator_unique_id_eq = opts.creatorId;
    }
    if (opts.workloadId !== undefined) {
      params.workload_id_eq = opts.workloadId;
    }
    if (opts.matched === true) {
      params.llm_request_log_id_not_null = 1;
    }
    if (opts.unmatched === true) {
      params.llm_request_log_id_null = 1;
    }
    if (opts.since !== undefined) {
      params.created_at_gteq = opts.since;
    }
    if (opts.sortBy !== undefined) {
      params.s = `${opts.sortBy} ${opts.sortDir ?? 'desc'}`;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.per = opts.perPage;
    }

    let result: SearchFeedbackResponse;
    try {
      result = await coolhand.searchFeedback(params);
    } catch (err) {
      throw mapFeedbackHttpError(err, 'Feedback search failed.');
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

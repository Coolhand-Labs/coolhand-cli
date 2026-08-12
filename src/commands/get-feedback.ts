import type { LLMRequestLogFeedbackDetail } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getFeedbackClient, mapFeedbackHttpError } from '../api/feedback-client.js';
import type { GetFeedbackOptions } from '../types.js';

const SUMMARY_FIELDS: Array<{ key: keyof LLMRequestLogFeedbackDetail; label: string }> = [
  { key: 'id', label: 'ID' },
  { key: 'sentiment', label: 'Sentiment' },
  { key: 'creator_type', label: 'Creator type' },
  { key: 'creator_unique_id', label: 'Creator ID' },
  { key: 'llm_request_log_id', label: 'Log ID' },
  { key: 'workload_id', label: 'Workload ID' },
  { key: 'collector', label: 'Collector' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
];

function printSummary(f: LLMRequestLogFeedbackDetail): void {
  for (const { key, label } of SUMMARY_FIELDS) {
    const v = f[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      logger.info(`${label}: ${v}`);
    }
  }
  if (f.explanation) {
    logger.info(`\nExplanation\n-----------\n${f.explanation}`);
  }
  if (f.original_output) {
    logger.info(`\nOriginal Output\n---------------\n${f.original_output}`);
  }
  if (f.revised_output) {
    logger.info(`\nRevised Output\n--------------\n${f.revised_output}`);
  }
  if (f.feedback_partials && f.feedback_partials.length > 0) {
    logger.info(`\nFeedback Partials (${f.feedback_partials.length})\n------------------`);
    for (const p of f.feedback_partials) {
      const label = [p.sentiment ?? 'N/A', p.focus_section].filter(Boolean).join(' — ');
      logger.info(`  [${p.id}] ${label}${p.explanation ? `: ${p.explanation}` : ''}`);
    }
  }
}

export async function run(opts: GetFeedbackOptions): Promise<number> {
  try {
    const coolhand = await getFeedbackClient({ clientId: opts.clientId });

    let result: LLMRequestLogFeedbackDetail;
    try {
      result = await coolhand.getFeedback(opts.id);
    } catch (err) {
      throw mapFeedbackHttpError(err, `Feedback "${opts.id}" not found (or does not belong to this client).`);
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      printSummary(result);
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

import type { GetStepTemplateOptions as GetStepTemplateParams, StepTemplate, StepTemplateMetrics } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getTemplateClient } from '../api/template-client.js';
import { mapStepTemplateHttpError } from '../api/step-template-client.js';
import type { GetStepTemplateOptions } from '../types.js';

const TIMEOUT_HINT = 'It is retryable; try again shortly, or pass --no-metrics to skip the metrics queries.';

const SUMMARY_FIELDS: Array<{ key: keyof StepTemplate; label: string }> = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'step_type', label: 'Step type' },
  { key: 'status', label: 'Status' },
  { key: 'sessions_count', label: 'Sessions' },
  { key: 'occurrences_count', label: 'Occurrences' },
  { key: 'last_seen_at', label: 'Last seen' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
];

function metricsLines(m: StepTemplateMetrics): string[] {
  const lines = [`Total runs: ${m.total_runs}`];
  if (m.turn_stats) {
    const { avg, median, high, single_turn_pct } = m.turn_stats;
    const single = single_turn_pct === null ? '' : `, single-turn ${single_turn_pct}%`;
    lines.push(`Turns: avg ${avg}, median ${median}, high ${high}${single}`);
  }
  if (m.tool_stats) {
    lines.push('Tools:');
    for (const t of m.tool_stats) {
      lines.push(`  ${t.name}: ${t.pct_of_runs}% of runs, ${t.avg_per_run} per run`);
    }
  }
  if (m.efficiency) {
    for (const cohort of ['interactive', 'automated', 'all'] as const) {
      const c = m.efficiency[cohort];
      if (c) {
        const tokens = c.tokens_available ? `, median ${c.median_tokens} tokens` : ', tokens n/a';
        lines.push(`Efficiency (${cohort}): ${c.runs} runs, ${c.avg_tool_calls} tool calls, ${c.avg_requests} requests${tokens}`);
      }
    }
    if (m.efficiency.unavailable_runs > 0) {
      lines.push(`Runs without a turn snapshot: ${m.efficiency.unavailable_runs}`);
    }
  }
  for (const note of m.notes) {
    lines.push(`Note: ${note}`);
  }
  return lines;
}

function printSummary(t: StepTemplate): void {
  for (const { key, label } of SUMMARY_FIELDS) {
    const v = t[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      logger.info(`${label}: ${v}`);
    }
  }
  if (t.user_turn_pattern) {
    logger.info(`\nUser Turn Pattern\n-----------------\n${t.user_turn_pattern}`);
  }
  if (t.metrics) {
    logger.info(`\nMetrics\n-------\n${metricsLines(t.metrics).join('\n')}`);
  }
}

export async function run(opts: GetStepTemplateOptions): Promise<number> {
  try {
    const coolhand = await getTemplateClient({ clientId: opts.clientId });

    const params: GetStepTemplateParams = {};
    if (opts.noMetrics) {
      params.includeMetrics = false;
    }

    let result: StepTemplate;
    try {
      result = await coolhand.getStepTemplate(opts.id, params);
    } catch (err) {
      throw mapStepTemplateHttpError(
        err,
        `Step template "${opts.id}" not found (or does not belong to this client).`,
        TIMEOUT_HINT
      );
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

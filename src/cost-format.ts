import type { LlmMetrics, LlmRequestLogCostBreakdown } from 'coolhand-node';
import type { MetricsWindowOptions } from './types.js';

/** USD with 4 decimals, or `n/a` when the cost is unknown (no tokens, or a model with no pricing). */
export function formatCost(cost: number | null | undefined): string {
  return typeof cost === 'number' ? cost.toFixed(4) : 'n/a';
}

/**
 * Maps the CLI's window flags to the SDK's. `since`/`until` pass through as the user typed them —
 * the server validates them, so a bad value comes back as its 422 rather than a local guess.
 */
export function metricsWindowParams(opts: MetricsWindowOptions): MetricsWindowOptions {
  const params: MetricsWindowOptions = {};
  if (opts.daysBack !== undefined) {
    params.daysBack = opts.daysBack;
  }
  if (opts.since !== undefined) {
    params.since = opts.since;
  }
  if (opts.until !== undefined) {
    params.until = opts.until;
  }
  return params;
}

export function metricsLines(m: LlmMetrics): string[] {
  return [
    `Window: ${m.since} to ${m.until}`,
    `Requests: ${m.request_count}  Failures: ${m.failure_count}`,
    `Total cost (USD): ${formatCost(m.total_cost)}  Priced requests: ${m.priced_request_count}`,
    `Input tokens: ${m.total_input_tokens}  Output tokens: ${m.total_output_tokens}`,
  ];
}

export function costBreakdownLine(b: LlmRequestLogCostBreakdown): string {
  return (
    `Cost breakdown (USD): input ${formatCost(b.input_cost)}, output ${formatCost(b.output_cost)}, ` +
    `cached input ${formatCost(b.cached_input_cost)}, cache creation ${formatCost(b.cache_creation_input_cost)}, ` +
    `reasoning output ${formatCost(b.reasoning_output_cost)}`
  );
}

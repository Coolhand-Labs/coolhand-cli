import type { LlmMetrics } from 'coolhand-node';

/**
 * USD with 4 decimals, or `n/a` when the server could not price it (`null`). A positive cost that
 * would round to `$0.0000` prints as `<$0.0001` so a cheap-but-priced log never reads as free.
 */
export function formatCost(cost: number | null | undefined): string {
  if (typeof cost !== 'number') {
    return 'n/a';
  }
  const fixed = cost.toFixed(4);
  return cost > 0 && Number(fixed) === 0 ? '<$0.0001' : `$${fixed}`;
}

/** The human-readable metrics summary shared by search-workloads and get-template. */
export function metricsLines(m: LlmMetrics): string[] {
  const window = typeof m.days_back === 'number' ? `last ${m.days_back} days, ` : '';
  return [
    `Window: ${window}${m.since} → ${m.until}`,
    `Requests: ${m.request_count} (${m.failure_count} failed)`,
    `Total cost: ${formatCost(m.total_cost)} (${m.priced_request_count} priced requests)`,
    `Tokens: ${m.total_input_tokens} in / ${m.total_output_tokens} out`,
  ];
}

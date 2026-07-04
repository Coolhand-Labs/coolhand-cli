import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { mcpCall } from './mcp-call.js';
import type { GetOptimizationOptions } from '../types.js';

const SUMMARY_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'optimization_type', label: 'Type' },
  { key: 'category', label: 'Category' },
  { key: 'impact', label: 'Impact' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'client_name', label: 'Client' },
  { key: 'template_name', label: 'Template' },
  { key: 'workload_name', label: 'Workload' },
  { key: 'created_at', label: 'Created' },
  { key: 'dismissal_explanation', label: 'Dismissal reason' },
];

function isWrapped(wrapper: Record<string, unknown>): boolean {
  return Boolean(wrapper) && typeof wrapper.optimization === 'object' && wrapper.optimization !== null;
}

function unwrapOptimization(result: unknown): Record<string, unknown> {
  const wrapper = result as Record<string, unknown>;
  return isWrapped(wrapper) ? (wrapper.optimization as Record<string, unknown>) : wrapper;
}

function stripOrchestratorMessages(r: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...r };
  delete rest.orchestrator_messages;
  return rest;
}

function printSummary(r: Record<string, unknown>): void {
  for (const { key, label } of SUMMARY_FIELDS) {
    const v = r[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      logger.info(`${label}: ${v}`);
    }
  }
  if (typeof r.analysis === 'string' && r.analysis.length > 0) {
    logger.info(`\nAnalysis\n--------\n${r.analysis}`);
  }
  if (typeof r.plan === 'string' && r.plan.length > 0) {
    logger.info(`\nPlan\n----\n${r.plan}`);
  }
}

export async function run(opts: GetOptimizationOptions): Promise<number> {
  try {
    const result = await mcpCall('get_optimization', { id: opts.id }, { clientId: opts.clientId });
    const r = unwrapOptimization(result);

    if (opts.json) {
      if (opts.full) {
        logger.json({ ok: true, result });
      } else {
        const wrapper = result as Record<string, unknown>;
        const stripped = isWrapped(wrapper)
          ? { ...wrapper, optimization: stripOrchestratorMessages(r) }
          : stripOrchestratorMessages(r);
        logger.json({ ok: true, result: stripped });
      }
      return ExitCode.OK;
    }

    printSummary(r);
    if (typeof r.pr_number === 'number' && typeof r.pr_url === 'string') {
      logger.info(`PR: #${r.pr_number} ${r.pr_url}`);
    }
    if (typeof r.coding_prompt === 'string') {
      logger.info(`\n--- Coding Prompt ---\n${r.coding_prompt}`);
    }
    logger.info(
      `\nNext steps:\n  coolhand close-optimization ${opts.id} "<reason>"\n  coolhand update-optimization ${opts.id} [--title V] [--analysis V] [--plan V]`
    );
    if (opts.full && r.orchestrator_messages !== undefined) {
      logger.info(`\n--- Orchestrator Messages (--full) ---\n${JSON.stringify(r.orchestrator_messages, null, 2)}`);
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

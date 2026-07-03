import type { ProxyWrapOptions } from '../types.js';
import { runWrapped, type WrapDeps } from '../proxy/wrap-runner.js';

/**
 * `coolhand proxy-wrap [--] <command> [args...]` — run an arbitrary CLI behind the
 * Coolhand proxy with the stored API key filled in. Generalizes the `claude`
 * command's proxy wiring to any child command.
 */
export async function run(opts: ProxyWrapOptions, deps: WrapDeps = {}): Promise<number> {
  return runWrapped(opts.command, opts.args, opts.clientId, deps);
}

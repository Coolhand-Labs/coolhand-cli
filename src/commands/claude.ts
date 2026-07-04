import type { ClaudeOptions } from '../types.js';
import { resolveWrapSpawn, runWrapped, type WrapDeps } from '../proxy/wrap-runner.js';

export function resolveSpawn(args: string[], platform = process.platform) {
  return resolveWrapSpawn('claude', args, platform);
}

/**
 * `coolhand claude [args...]` — run the Claude CLI behind the Coolhand proxy with
 * the stored API key filled in. Starts an in-process HTTPS MITM proxy and spawns
 * claude with proxy env vars set.
 */
export async function run(opts: ClaudeOptions, deps: WrapDeps = {}): Promise<number> {
  return runWrapped('claude', opts.args, opts.clientId, deps);
}

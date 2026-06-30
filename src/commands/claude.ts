import { spawn } from 'child_process';
import { createRequire } from 'module';
import { realpathSync } from 'fs';
import { ExitCode, CliError } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, resolveClient } from '../config.js';
import { DEFAULT_BASE_URL, type ClaudeOptions } from '../types.js';

interface ClaudeDeps {
  spawnFn?: typeof spawn;
  // Resolves the installed coolhand-proxy CLI entry file. Injectable for tests.
  resolveProxyCli?: () => string;
}

/**
 * Locate the coolhand-proxy CLI (`dist/cli.js`, which hosts the `wrap` command).
 * coolhand-proxy ships dist/ and declares no `exports` restriction, so deep
 * subpath resolution works. We resolve a file path and later run it with `node`
 * rather than via the `.bin` shim, which avoids the Windows `.bin` ENOENT gotcha.
 */
function defaultResolveProxyCli(): string {
  // Anchor resolution at the real path of the running CLI entry (dist/bin.js),
  // following any global-install symlink, so we resolve coolhand-proxy from this
  // package's node_modules. Avoids `import.meta` (keeps the ts-jest build happy).
  const anchor = realpathSync(process.argv[1] ?? process.cwd());
  const require = createRequire(anchor);
  return require.resolve('coolhand-proxy/dist/cli.js');
}

/**
 * Build the full ingest endpoint the proxy should post to for a given client.
 * The proxy's `--api-endpoint` wants the full path; the CLI stores only the
 * site base_url, so append the ingest path. Returns undefined for the default
 * base_url (the proxy already targets the right endpoint).
 */
function endpointForBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl || baseUrl === DEFAULT_BASE_URL) {
    return undefined;
  }
  return `${baseUrl.replace(/\/+$/, '')}/api/v2/llm_request_logs`;
}

/**
 * `coolhand claude [args...]` — run the Claude CLI behind the Coolhand proxy with
 * the stored API key filled in. Shells out to `coolhand-proxy wrap -- claude ...`
 * so the proxy's battle-tested wrap behavior is reused, not duplicated.
 */
export async function run(opts: ClaudeOptions, deps: ClaudeDeps = {}): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn;
  const resolveProxyCli = deps.resolveProxyCli ?? defaultResolveProxyCli;

  try {
    const cfg = await loadConfig();
    const entry = await resolveClient(cfg, opts.clientId);
    if (!entry.api_key) {
      throw new CliError(
        'NOT_CONFIGURED',
        'This client has no public API key — LLM capture requires the public key. Run `coolhand login` to re-authenticate.'
      );
    }

    let proxyCli: string;
    try {
      proxyCli = resolveProxyCli();
    } catch {
      logger.info('Error: could not locate the coolhand-proxy dependency. Try reinstalling coolhand-cli.');
      return ExitCode.INTERNAL;
    }

    const wrapArgs = ['wrap', '--silent'];
    const endpoint = endpointForBaseUrl(entry.base_url);
    if (endpoint) {
      wrapArgs.push('--api-endpoint', endpoint);
    }
    wrapArgs.push('--', 'claude', ...opts.args);

    return await new Promise<number>((resolve) => {
      const child = spawnFn(process.execPath, [proxyCli, ...wrapArgs], {
        stdio: 'inherit',
        env: { ...process.env, COOLHAND_API_KEY: entry.api_key },
      });
      child.on('error', (err: Error) => {
        logger.info(`Error: failed to start coolhand-proxy: ${redact(err.message)}`);
        resolve(ExitCode.INTERNAL);
      });
      child.on('close', (code: number | null) => {
        resolve(code ?? ExitCode.INTERNAL);
      });
    });
  } catch (err) {
    if (err instanceof CliError) {
      logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      return err.exitCode;
    }
    throw err;
  }
}

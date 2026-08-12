import { spawn } from 'child_process';
import { ExitCode, CliError } from '../errors.js';
import { isAllowedBaseUrlScheme } from '../base-url.js';
import { logger, redact } from '../logger.js';
import { loadConfig, resolveClient } from '../config.js';
import { DEFAULT_BASE_URL } from '../types.js';
import { startProxy, type ProxyInstance } from './proxy.js';
import { getOrCreateCA, getCertPath } from './certs.js';
import { PACKAGE_IDENTIFIER } from '../version.js';

export interface WrapDeps {
  spawnFn?: typeof spawn;
  startProxyFn?: (ca: Awaited<ReturnType<typeof getOrCreateCA>>, opts: Parameters<typeof startProxy>[1]) => Promise<ProxyInstance>;
}

/**
 * On Windows, .cmd shims cannot be spawned without a shell. Rather than using
 * shell:true (which forwards args as an unquoted string to cmd.exe, enabling
 * metacharacter injection), we invoke cmd.exe /d /s /c directly with the command
 * and each arg double-quoted and windowsVerbatimArguments:true so Node does not
 * re-quote them.
 *
 * Quoting rules applied to the command and every arg:
 *   1. Double trailing backslashes (a trailing \ would escape the closing ")
 *   2. Escape embedded " as ""
 *   3. Escape % as %% to prevent cmd.exe environment-variable expansion
 *   4. Wrap in double quotes unconditionally
 */
function escapeForCmdExe(s: string): string {
  return s
    .replace(/(\\+)$/, '$1$1')  // double trailing backslashes
    .replace(/"/g, '""')         // escape embedded quotes
    .replace(/%/g, '%%');        // prevent env-var expansion
}

export function resolveWrapSpawn(
  cmd: string,
  args: string[],
  platform = process.platform
): { cmd: string; spawnArgs: string[]; windowsVerbatimArguments?: true } {
  if (platform !== 'win32') {
    return { cmd, spawnArgs: args };
  }
  const escapedCmd = `"${escapeForCmdExe(cmd)}"`;
  const escapedArgs = args.map((a) => `"${escapeForCmdExe(a)}"`);
  return {
    cmd: process.env['ComSpec'] ?? 'cmd.exe',
    spawnArgs: ['/d', '/s', '/c', [escapedCmd, ...escapedArgs].join(' ')],
    windowsVerbatimArguments: true,
  };
}

/**
 * Build the full ingest endpoint for a given client's base_url.
 * The CLI stores only the site base_url, so append the ingest path here.
 * Returns undefined for the default base_url (the proxy already uses the right endpoint).
 */
export function endpointForBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl || baseUrl === DEFAULT_BASE_URL) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url in stored config: ${baseUrl}`);
  }
  if (!isAllowedBaseUrlScheme(parsed)) {
    throw new CliError(
      'INVALID_BASE_URL',
      `base_url must use https:// (got: ${baseUrl}). For local dev, http://localhost is allowed.`
    );
  }
  return `${baseUrl.replace(/\/+$/, '')}/api/v2/llm_request_logs`;
}

/**
 * Run an arbitrary child command behind the Coolhand proxy with the stored API key
 * filled in. Starts an in-process HTTPS MITM proxy and spawns `cmd` with proxy env vars.
 */
export async function runWrapped(
  cmd: string,
  args: string[],
  clientId: string | undefined,
  deps: WrapDeps = {}
): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn;

  try {
    const cfg = await loadConfig();
    const entry = await resolveClient(cfg, clientId);
    if (!entry.api_key) {
      throw new CliError(
        'NOT_CONFIGURED',
        'This client has no public API key — LLM capture requires the public key. Run `coolhand login` to re-authenticate.'
      );
    }

    const ca = await getOrCreateCA();
    const certPath = getCertPath();
    const apiEndpoint = endpointForBaseUrl(entry.base_url);
    const proxy = await (deps.startProxyFn ?? startProxy)(ca, {
      apiKey: entry.api_key,
      apiEndpoint,
      silent: true,
      collector: `${PACKAGE_IDENTIFIER}/${cmd}`,
    });

    return new Promise<number>((resolve) => {
      let stopped = false;
      // stopped is set synchronously before the first await so concurrent
      // callers (error + close can both fire) see it immediately and skip.
      const stopOnce = () => {
        if (stopped) { return Promise.resolve(); }
        stopped = true;
        return proxy.stop();
      };

      let child;
      try {
        const { cmd: spawnCmd, spawnArgs, windowsVerbatimArguments } = resolveWrapSpawn(cmd, args);
        child = spawnFn(spawnCmd, spawnArgs, {
          stdio: 'inherit',
          windowsVerbatimArguments,
          env: {
            ...process.env,
            COOLHAND_API_KEY: entry.api_key,
            HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
            HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
            NO_PROXY: 'localhost,127.0.0.1,::1',
            SSL_CERT_FILE: certPath,
            NODE_EXTRA_CA_CERTS: certPath,
            REQUESTS_CA_BUNDLE: certPath,
          },
        });
      } catch (spawnErr) {
        if (spawnErr instanceof Error) { logger.info(`Error: ${redact(spawnErr.message)}`); }
        // Chain .catch → .then so resolve() is called only after stop() drains,
        // mirroring the error/close handler pattern and avoiding abandoned sends.
        stopOnce()
          .catch((e: unknown) => {
            const msg = e instanceof Error ? redact(e.message) : String(e);
            logger.info(`Error: ${msg}`);
          })
          .then(() => resolve(ExitCode.INTERNAL));
        return;
      }
      child.on('error', async (err: Error) => {
        try {
          await stopOnce();
        } catch (stopErr: unknown) {
          if (stopErr instanceof Error) { logger.info(`Error: ${redact(stopErr.message)}`); }
        } finally {
          logger.info(`Error: ${redact(err.message)}`);
          resolve(ExitCode.INTERNAL);
        }
      });
      child.on('close', async (code: number | null) => {
        try {
          await stopOnce();
        } catch (stopErr: unknown) {
          if (stopErr instanceof Error) { logger.info(`Error: ${redact(stopErr.message)}`); }
        } finally {
          resolve(code ?? ExitCode.INTERNAL);
        }
      });
    });
  } catch (err) {
    if (err instanceof CliError) {
      logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      return err.exitCode;
    }
    if (err instanceof Error) {
      logger.info(`Error: ${redact(err.message)}`);
    }
    return ExitCode.INTERNAL;
  }
}

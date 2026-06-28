import { spawn } from 'child_process';
import { ExitCode, CliError } from '../errors.js';
import { logger, redact } from '../logger.js';
import { loadConfig, getClient } from '../config.js';
import { DEFAULT_BASE_URL, type ClaudeOptions } from '../types.js';
import { startProxy, type ProxyInstance } from '../proxy/proxy.js';
import { getOrCreateCA, getCertPath } from '../proxy/certs.js';

interface ClaudeDeps {
  spawnFn?: typeof spawn;
  startProxyFn?: (ca: Awaited<ReturnType<typeof getOrCreateCA>>, opts: Parameters<typeof startProxy>[1]) => Promise<ProxyInstance>;
}

/**
 * On Windows, .cmd shims cannot be spawned without a shell. Rather than using
 * shell:true (which forwards args as an unquoted string to cmd.exe, enabling
 * metacharacter injection), we invoke cmd.exe /d /s /c directly with each arg
 * double-quoted and windowsVerbatimArguments:true so Node does not re-quote them.
 */
function resolveSpawn(args: string[]): { cmd: string; spawnArgs: string[]; windowsVerbatimArguments?: true } {
  if (process.platform !== 'win32') {
    return { cmd: 'claude', spawnArgs: args };
  }
  const escaped = args.map((a) =>
    /[\s"<>|^&]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a
  );
  return {
    cmd: process.env['ComSpec'] ?? 'cmd.exe',
    spawnArgs: ['/d', '/s', '/c', ['claude', ...escaped].join(' ')],
    windowsVerbatimArguments: true,
  };
}

/**
 * Build the full ingest endpoint for a given client's base_url.
 * The CLI stores only the site base_url, so append the ingest path here.
 * Returns undefined for the default base_url (the proxy already uses the right endpoint).
 */
function endpointForBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl || baseUrl === DEFAULT_BASE_URL) {
    return undefined;
  }
  return `${baseUrl.replace(/\/+$/, '')}/api/v2/llm_request_logs`;
}

/**
 * `coolhand claude [args...]` — run the Claude CLI behind the Coolhand proxy with
 * the stored API key filled in. Starts an in-process HTTPS MITM proxy and spawns
 * claude with proxy env vars set.
 */
export async function run(opts: ClaudeOptions, deps: ClaudeDeps = {}): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn;

  try {
    const cfg = await loadConfig();
    const entry = getClient(cfg, opts.clientId);
    if (!entry) {
      throw new CliError('NOT_CONFIGURED', 'No Coolhand account configured. Run `coolhand login` first.');
    }

    const ca = await getOrCreateCA();
    const certPath = getCertPath();
    const apiEndpoint = endpointForBaseUrl(entry.base_url);
    const proxy = await (deps.startProxyFn ?? startProxy)(ca, {
      apiKey: entry.api_key,
      apiEndpoint,
      silent: true,
    });

    return new Promise<number>((resolve) => {
      let stopped = false;
      const stopOnce = () => {
        if (stopped) { return Promise.resolve(); }
        stopped = true;
        return proxy.stop();
      };

      const { cmd, spawnArgs, windowsVerbatimArguments } = resolveSpawn(opts.args);
      const child = spawnFn(cmd, spawnArgs, {
        stdio: 'inherit',
        windowsVerbatimArguments,
        env: {
          ...process.env,
          HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
          SSL_CERT_FILE: certPath,
          NODE_EXTRA_CA_CERTS: certPath,
          REQUESTS_CA_BUNDLE: certPath,
        },
      });
      child.on('error', async (err: Error) => {
        try {
          await stopOnce();
        } finally {
          logger.info(`Error: ${redact(err.message)}`);
          resolve(ExitCode.INTERNAL);
        }
      });
      child.on('close', async (code: number | null) => {
        try {
          await stopOnce();
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

import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { maskToken } from '../mask.js';
import { upsertClient, configPath } from '../config.js';
import { writeEnvKey } from '../env-file.js';
import { startCallbackServer } from '../auth/callback-server.js';
import { openBrowser } from '../auth/open-browser.js';
import { generateState } from '../auth/state.js';
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, type ClientEntry, type LoginOptions } from '../types.js';

function parseBaseUrl(input: string | undefined): URL {
  const raw = input ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError('INVALID_BASE_URL', `Invalid --base-url: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('INVALID_BASE_URL', `--base-url must be http or https, got: ${parsed.protocol}`);
  }
  return parsed;
}

function reportError(err: CliError, json: boolean | undefined): void {
  if (json) {
    logger.json({ ok: false, error: err.code, message: redact(err.message) });
  } else {
    logger.info(`Error: ${redact(err.message)} [${err.code}]`);
  }
}

export async function run(opts: LoginOptions): Promise<number> {
  let baseUrl: URL;
  try {
    baseUrl = parseBaseUrl(opts.baseUrl);
  } catch (err) {
    if (err instanceof CliError) {
      reportError(err, opts.json);
      return err.exitCode;
    }
    throw err;
  }
  const state = generateState();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const handle = await startCallbackServer({ expectedState: state, timeoutMs });

  const redirectUri = `http://127.0.0.1:${handle.port}/callback`;
  const authUrl = new URL('/cli/auth', baseUrl);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  if (opts.clientId) {
    authUrl.searchParams.set('client_id', opts.clientId);
  }
  if (opts.scope === 'private') {
    authUrl.searchParams.set('scope', 'private');
  }

  const onSignal = (sig: NodeJS.Signals): void => {
    logger.info(`\nAborted (${sig}).`);
    handle.close().finally(() => {
      process.exit(ExitCode.ABORTED);
    });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const signalCleanup = (): void => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };

  try {
    logger.info(`Opening browser to ${authUrl.toString()}`);
    logger.info('If your browser does not open, paste the URL above into it manually.');
    logger.info(`Waiting for browser authentication... (Ctrl+C to cancel; ${Math.round(timeoutMs / 1000)}s timeout)`);

    await openBrowser(authUrl.toString());

    const callback = await handle.result;
    if (opts.scope === 'private' && !callback.private_token) {
      throw new CliError(
        'INVALID_CALLBACK',
        'Private scope was requested, but the callback was missing private_token. Make sure your Coolhand server is up to date.'
      );
    }

    const entry: ClientEntry = {
      client_id: callback.clientId,
      client_name: callback.clientName,
      api_key: callback.token,
      ...(callback.private_token ? { private_key: callback.private_token } : {}),
      base_url: baseUrl.origin,
      saved_at: new Date().toISOString(),
    };
    await upsertClient(entry, true);

    let envResult: { path: string; created: boolean; replaced: boolean } | undefined;
    let privateEnvResult: { path: string; created: boolean; replaced: boolean } | undefined;
    if (opts.writeEnv) {
      envResult = await writeEnvKey(opts.writeEnv, 'COOLHAND_API_KEY', callback.token);
      if (callback.private_token) {
        privateEnvResult = await writeEnvKey(opts.writeEnv, 'COOLHAND_PRIVATE_KEY', callback.private_token);
      }
    }

    if (opts.json) {
      logger.json({
        ok: true,
        masked_token: maskToken(callback.token),
        ...(callback.private_token ? { masked_private_key: maskToken(callback.private_token) } : {}),
        client_id: callback.clientId,
        client_name: callback.clientName,
        base_url: baseUrl.origin,
        config_path: configPath(),
        env_file: envResult
          ? { path: envResult.path, created: envResult.created, replaced: envResult.replaced }
          : null,
        private_env_file: privateEnvResult
          ? { path: privateEnvResult.path, created: privateEnvResult.created, replaced: privateEnvResult.replaced }
          : null,
      });
    } else {
      logger.info(`Logged in as "${callback.clientName}" (${callback.clientId}).`);
      logger.info(`Saved to ${configPath()}.`);
      if (envResult) {
        const action = envResult.created ? 'created' : envResult.replaced ? 'updated' : 'appended to';
        logger.info(`COOLHAND_API_KEY ${action} ${envResult.path}.`);
      }
      if (privateEnvResult) {
        const action = privateEnvResult.replaced ? 'updated' : 'appended to';
        logger.info(`COOLHAND_PRIVATE_KEY ${action} ${privateEnvResult.path}.`);
      }
    }
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CliError) {
      reportError(err, opts.json);
      return err.exitCode;
    }
    throw err;
  } finally {
    signalCleanup();
    await handle.close().catch(() => undefined);
  }
}

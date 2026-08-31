import { promises as fs } from 'fs';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError } from './errors.js';
import { logger, stripAnsiEscapes } from './logger.js';
import type { ClientEntry, ConfigFile } from './types.js';

const CONFIG_FILENAME = 'config.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function configDir(): string {
  const override = process.env.COOLHAND_CONFIG_DIR;
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.coolhand');
}

export function configPath(): string {
  return path.join(configDir(), CONFIG_FILENAME);
}

function emptyConfig(): ConfigFile {
  return { version: 1, default_client_id: null, clients: {}, feature_flags: [] };
}

export async function loadConfig(): Promise<ConfigFile> {
  const filePath = configPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return emptyConfig();
    }
    throw new CliError('CONFIG_READ_FAILED', `Failed to read ${filePath}: ${e.message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    // feature_flags is external input: keep only non-empty strings, trimmed to match env-var parsing.
    const feature_flags = Array.isArray(parsed.feature_flags)
      ? parsed.feature_flags
          .filter((group): group is string => typeof group === 'string')
          .map((group) => group.trim())
          .filter((group) => group.length > 0)
      : [];
    return {
      version: 1,
      default_client_id: parsed.default_client_id ?? null,
      clients: parsed.clients ?? {},
      feature_flags,
    };
  } catch (err) {
    throw new CliError(
      'CONFIG_READ_FAILED',
      `Config file at ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // POSIX-only — Windows will reject chmod with the mode we passed; ignore.
  }
}

/**
 * Write a file atomically with restrictive permissions: write to a temp file in the
 * same directory, then rename it into place (rename is atomic on POSIX), so a reader
 * never sees a half-written file. The caller is responsible for ensuring the parent
 * directory exists. Shared by `saveConfig` and the pending-record store.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  mode: number = FILE_MODE
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmpPath, data, { mode });
    await fs.rename(tmpPath, filePath);
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // ignore on Windows
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw new CliError('CONFIG_WRITE_FAILED', `Failed to write ${filePath}: ${(err as Error).message}`);
  }
}

export async function saveConfig(cfg: ConfigFile): Promise<void> {
  const filePath = configPath();
  await ensureDir(path.dirname(filePath));
  await atomicWriteFile(filePath, `${JSON.stringify(cfg, null, 2)}\n`, FILE_MODE);
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.rm(configPath(), { force: true });
  } catch (err) {
    throw new CliError('CONFIG_WRITE_FAILED', `Failed to delete config: ${(err as Error).message}`);
  }
}

export function getClient(cfg: ConfigFile, clientId?: string): ClientEntry | undefined {
  const id = clientId ?? cfg.default_client_id;
  if (!id) {
    return undefined;
  }
  return cfg.clients[id];
}

export async function upsertClient(entry: ClientEntry, makeDefault = true): Promise<ConfigFile> {
  const cfg = await loadConfig();
  // Merge onto any existing entry for this client_id so a partial entry (e.g. a
  // public-only re-login) doesn't silently drop fields it didn't provide, such as a
  // previously-stored private_key.
  const existing = cfg.clients[entry.client_id];
  cfg.clients[entry.client_id] = existing ? { ...existing, ...entry } : entry;
  if (makeDefault || !cfg.default_client_id) {
    cfg.default_client_id = entry.client_id;
  }
  await saveConfig(cfg);
  return cfg;
}

export async function removeClient(clientId: string): Promise<ConfigFile | null> {
  const cfg = await loadConfig();
  if (!cfg.clients[clientId]) {
    return cfg;
  }
  delete cfg.clients[clientId];
  const remaining = Object.keys(cfg.clients);
  if (remaining.length === 0) {
    await deleteConfig();
    return null;
  }
  if (cfg.default_client_id === clientId) {
    cfg.default_client_id = remaining[0];
  }
  await saveConfig(cfg);
  return cfg;
}

export async function setDefault(clientId: string): Promise<ConfigFile> {
  const cfg = await loadConfig();
  if (!cfg.clients[clientId]) {
    throw new CliError('CLIENT_NOT_FOUND', `No client with id "${clientId}" is configured.`);
  }
  cfg.default_client_id = clientId;
  await saveConfig(cfg);
  return cfg;
}

const PROMPT_TIMEOUT_MS = 30_000;

async function promptClientSelection(clients: ClientEntry[]): Promise<ClientEntry> {
  return new Promise<ClientEntry>((resolve, reject) => {
    const lines = clients.map((c, i) => `  ${i + 1}. ${stripAnsiEscapes(c.client_name)} (${c.client_id})`).join('\n');
    process.stderr.write(`Multiple clients configured — which one?\n${lines}\nEnter number: `);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) { return; }
      settled = true;
      rl.close();
      process.stdin.pause();
      reject(new CliError('INVALID_ARGS', 'No selection made within 30 seconds — pass --client-id to skip this prompt.'));
    }, PROMPT_TIMEOUT_MS);
    timer.unref();

    rl.once('line', (answer: string) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      rl.close();
      process.stdin.pause();
      const n = parseInt(answer.trim(), 10);
      if (isNaN(n) || n < 1 || n > clients.length) {
        reject(new CliError('INVALID_ARGS', `Invalid selection "${answer.trim()}" — enter a number between 1 and ${clients.length}.`));
      } else {
        resolve(clients[n - 1]);
      }
    });
    rl.once('close', () => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      reject(new CliError('INVALID_ARGS', 'No client selected.'));
    });
  });
}

/**
 * Resolves which client to use for an API command. Priority:
 *   explicit clientId arg > COOLHAND_CLIENT_ID env > default_client_id config >
 *   auto-pick if only one client exists > interactive prompt (TTY) or error.
 *
 * Prints "Client: <name> (<id>)" to stderr after resolution so the user always
 * knows which account's data they are looking at.
 */
export async function resolveClient(cfg: ConfigFile, clientId?: string): Promise<ClientEntry> {
  if (clientId === '') {
    throw new CliError('INVALID_ARGS', 'clientId must not be empty');
  }
  // 1. Explicit --client-id
  if (clientId !== undefined) {
    const entry = cfg.clients[clientId];
    if (!entry) {
      throw new CliError('CLIENT_NOT_FOUND', `No client "${clientId}" is configured.`);
    }
    process.stderr.write(`Client: ${stripAnsiEscapes(entry.client_name)} (${entry.client_id})\n`);
    return entry;
  }

  // 2. COOLHAND_CLIENT_ID env var
  // An empty string env var (COOLHAND_CLIENT_ID="") is treated as unset and falls
  // through to the default/auto-pick path. This differs from an explicit empty
  // --client-id "" argument (caught above as INVALID_ARGS) because an empty env var
  // is most likely an accidental mis-set in a script, not a deliberate selection.
  const envClientId = process.env.COOLHAND_CLIENT_ID;
  if (envClientId) {
    const entry = cfg.clients[envClientId];
    if (!entry) {
      throw new CliError(
        'CLIENT_NOT_FOUND',
        `COOLHAND_CLIENT_ID="${envClientId}" does not match any configured client.`
      );
    }
    process.stderr.write(`Client: ${stripAnsiEscapes(entry.client_name)} (${entry.client_id})\n`);
    return entry;
  }

  // 3. Configured default
  if (cfg.default_client_id) {
    const entry = cfg.clients[cfg.default_client_id];
    if (entry) {
      process.stderr.write(`Client: ${stripAnsiEscapes(entry.client_name)} (${entry.client_id})\n`);
      return entry;
    }
    logger.warn(
      `Configured default client "${cfg.default_client_id}" no longer exists. Run \`coolhand clients use <id>\` to reset it.`
    );
  }

  const clients = Object.values(cfg.clients);

  // 4. No clients at all
  if (clients.length === 0) {
    throw new CliError('NOT_CONFIGURED', 'Not logged in. Run `coolhand login` to authenticate.');
  }

  // 5. Exactly one client — auto-pick without prompting
  if (clients.length === 1) {
    const entry = clients[0];
    process.stderr.write(`Client: ${stripAnsiEscapes(entry.client_name)} (${entry.client_id})\n`);
    return entry;
  }

  // 6. Multiple clients, no default — prompt interactively when both stdin and stderr are a
  //    TTY. The prompt writes to stderr, so checking stderr.isTTY (not stdout.isTTY) is the
  //    right signal that the user can see and respond to it. When stdin is not a TTY the user
  //    cannot type a selection, so the descriptive error path is cleaner.
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const entry = await promptClientSelection(clients);
    process.stderr.write(`Client: ${stripAnsiEscapes(entry.client_name)} (${entry.client_id})\n`);
    return entry;
  }

  const list = clients.map((c) => `  ${c.client_id}  ${stripAnsiEscapes(c.client_name)}`).join('\n');
  throw new CliError(
    'NOT_CONFIGURED',
    `Multiple clients configured but no default is set.\n\nConfigured clients:\n${list}\n\nRun \`coolhand clients use <id>\` to set a default, or pass --client-id.`
  );
}

/**
 * `resolveClient`, but tolerant of "no clients configured at all" — returns `undefined` in that
 * one case instead of throwing, so a `--dry-run` caller can still run fully unauthenticated. Any
 * other resolution error (a bad --client-id, multiple clients with no default set, etc.)
 * propagates exactly as `resolveClient` would throw it.
 *
 * Shared by every command whose `--dry-run` mode should work without any stored credentials
 * (`analyze-claude-sessions`, `map-claude-projects`, `upload-client-file`, and anything built on
 * `uploadClientFile`'s shared core).
 */
export async function resolveClientForDryRun(cfg: ConfigFile, clientId?: string): Promise<ClientEntry | undefined> {
  try {
    return await resolveClient(cfg, clientId);
  } catch (err) {
    if (
      !(err instanceof CliError) ||
      err.code !== 'NOT_CONFIGURED' ||
      Object.keys(cfg.clients).length > 0
    ) {
      throw err;
    }
    return undefined;
  }
}

import { promises as fs } from 'fs';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError } from './errors.js';
import { logger } from './logger.js';
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
  return { version: 1, default_client_id: null, clients: {} };
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
    return {
      version: 1,
      default_client_id: parsed.default_client_id ?? null,
      clients: parsed.clients ?? {},
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

export async function saveConfig(cfg: ConfigFile): Promise<void> {
  const filePath = configPath();
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  const data = `${JSON.stringify(cfg, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, data, { mode: FILE_MODE });
    await fs.rename(tmpPath, filePath);
    try {
      await fs.chmod(filePath, FILE_MODE);
    } catch {
      // ignore on Windows
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw new CliError('CONFIG_WRITE_FAILED', `Failed to write ${filePath}: ${(err as Error).message}`);
  }
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
  cfg.clients[entry.client_id] = entry;
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
    const lines = clients.map((c, i) => `  ${i + 1}. ${c.client_name} (${c.client_id})`).join('\n');
    process.stderr.write(`Multiple clients configured — which one?\n${lines}\nEnter number: `);
    const rl = createInterface({ input: process.stdin });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) { return; }
      settled = true;
      rl.close();
      reject(new CliError('INVALID_ARGS', 'No selection made within 30 seconds — pass --client-id to skip this prompt.'));
    }, PROMPT_TIMEOUT_MS);
    timer.unref();

    rl.once('line', (answer: string) => {
      if (settled) { return; }
      settled = true;
      rl.close();
      clearTimeout(timer);
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
    process.stderr.write(`Client: ${entry.client_name} (${entry.client_id})\n`);
    return entry;
  }

  // 2. COOLHAND_CLIENT_ID env var
  const envClientId = process.env.COOLHAND_CLIENT_ID;
  if (envClientId) {
    const entry = cfg.clients[envClientId];
    if (!entry) {
      throw new CliError(
        'CLIENT_NOT_FOUND',
        `COOLHAND_CLIENT_ID="${envClientId}" does not match any configured client.`
      );
    }
    process.stderr.write(`Client: ${entry.client_name} (${entry.client_id})\n`);
    return entry;
  }

  // 3. Configured default
  if (cfg.default_client_id) {
    const entry = cfg.clients[cfg.default_client_id];
    if (entry) {
      process.stderr.write(`Client: ${entry.client_name} (${entry.client_id})\n`);
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
    process.stderr.write(`Client: ${entry.client_name} (${entry.client_id})\n`);
    return entry;
  }

  // 6. Multiple clients, no default — prompt interactively on a TTY, error otherwise
  if (process.stdin.isTTY) {
    const entry = await promptClientSelection(clients);
    process.stderr.write(`Client: ${entry.client_name} (${entry.client_id})\n`);
    return entry;
  }

  const list = clients.map((c) => `  ${c.client_id}  ${c.client_name}`).join('\n');
  throw new CliError(
    'NOT_CONFIGURED',
    `Multiple clients configured but no default is set.\n\nConfigured clients:\n${list}\n\nRun \`coolhand clients use <id>\` to set a default, or pass --client-id.`
  );
}

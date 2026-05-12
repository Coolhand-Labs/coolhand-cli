import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CliError } from './errors.js';
import type { AccountEntry, ConfigFile } from './types.js';

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
  return { version: 1, default_account_id: null, accounts: {} };
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
      default_account_id: parsed.default_account_id ?? null,
      accounts: parsed.accounts ?? {},
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

export function getAccount(cfg: ConfigFile, accountId?: string): AccountEntry | undefined {
  const id = accountId ?? cfg.default_account_id;
  if (!id) {
    return undefined;
  }
  return cfg.accounts[id];
}

export async function upsertAccount(entry: AccountEntry, makeDefault = true): Promise<ConfigFile> {
  const cfg = await loadConfig();
  cfg.accounts[entry.account_id] = entry;
  if (makeDefault || !cfg.default_account_id) {
    cfg.default_account_id = entry.account_id;
  }
  await saveConfig(cfg);
  return cfg;
}

export async function removeAccount(accountId: string): Promise<ConfigFile | null> {
  const cfg = await loadConfig();
  if (!cfg.accounts[accountId]) {
    return cfg;
  }
  delete cfg.accounts[accountId];
  const remaining = Object.keys(cfg.accounts);
  if (remaining.length === 0) {
    await deleteConfig();
    return null;
  }
  if (cfg.default_account_id === accountId) {
    cfg.default_account_id = remaining[0];
  }
  await saveConfig(cfg);
  return cfg;
}

export async function setDefault(accountId: string): Promise<ConfigFile> {
  const cfg = await loadConfig();
  if (!cfg.accounts[accountId]) {
    throw new CliError('ACCOUNT_NOT_FOUND', `No account with id "${accountId}" is configured.`);
  }
  cfg.default_account_id = accountId;
  await saveConfig(cfg);
  return cfg;
}

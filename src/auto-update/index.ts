import { spawn, type StdioOptions } from 'child_process';
import { readFileSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAllowedBaseUrlScheme } from '../base-url.js';
import { configDir, loadConfig } from '../config.js';
import { ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import { resolveWrapSpawn } from '../win-spawn.js';
import { BAKE_PERIOD_MS, compareSemver, parseStable, selectUpdate, type Packument } from './select.js';
import { acquireLock, loadState, saveState, type UpdateState } from './state.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const NPM_CONFIG_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** A failed install blocks retrying the same version this long; transient causes (no `npm` on PATH, offline) shouldn't stick forever. */
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Working directory for every spawn. npm reads a project-level `.npmrc` from the cwd, even for `-g`, so a
 * cloned repo could point the silent install at its own registry; the home directory only has the user's own config.
 */
function neutralCwd(): string {
  return os.homedir();
}

/** Commands that must never trigger (or announce) an update: the updater itself, the other background job, and passive output. */
const NO_AUTO_UPDATE = new Set(['__auto-update', '__flush-pending', 'capture-turn', 'update', 'help', 'version']);

/** Package-manager layouts that own their own global installs; `npm install -g` would create a second copy instead of upgrading this one. */
const FOREIGN_MANAGERS = ['_npx', '.volta', '.pnpm', 'pnpm', '.yarn', '.bun'];

/**
 * True when `scriptPath` looks like a global `npm install -g` of this package:
 * `<prefix>/lib/node_modules/<pkg>/…` (macOS/Linux, nvm, Homebrew) or `<prefix>/node_modules/<pkg>/…`
 * under an `npm` directory (Windows). A project-local install (`<project>/node_modules`), `npx` cache,
 * `npm link` checkout, or another package manager's global dir does not match, so we never touch it.
 */
export function isGlobalNpmInstall(scriptPath: string): boolean {
  const parts = scriptPath.split(/[\\/]+/);
  const at = parts.lastIndexOf(PACKAGE_NAME);
  if (at < 2 || parts[at - 1] !== 'node_modules') {
    return false;
  }
  if (parts.some((p) => FOREIGN_MANAGERS.includes(p.toLowerCase()))) {
    return false;
  }
  const owner = (parts[at - 2] ?? '').toLowerCase();
  return owner === 'lib' || owner === 'npm';
}

function runningScript(): string | undefined {
  const argv1 = process.argv[1];
  if (!argv1) {
    return undefined;
  }
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

export function canSelfInstall(): boolean {
  const script = runningScript();
  return script !== undefined && isGlobalNpmInstall(script);
}

/** Set means non-empty and not an explicit "0"/"false", so `CI=false` in a dev shell doesn't disable updates. */
function envFlag(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

function optedOutByEnv(): boolean {
  return envFlag('COOLHAND_NO_AUTO_UPDATE') || envFlag('CI');
}

/**
 * The validated `COOLHAND_UPDATE_REGISTRY` override, undefined when unset. A value that is set but rejected
 * throws rather than falling back to the public registry, which someone using a private mirror may be avoiding.
 */
function registryOverride(): string | undefined {
  const override = process.env.COOLHAND_UPDATE_REGISTRY;
  if (!override) {
    return undefined;
  }
  try {
    const url = new URL(override);
    // Credentials would end up in `npm`'s argv (visible in the process list); auth belongs in .npmrc.
    if (isAllowedBaseUrlScheme(url) && !url.username && !url.password && !url.search && !url.hash) {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // fall through to the error below
  }
  throw new Error(
    'COOLHAND_UPDATE_REGISTRY must be an https:// URL (http:// only for localhost) without credentials, query, or fragment'
  );
}

function registryUrl(): string {
  return registryOverride() ?? DEFAULT_REGISTRY;
}

export async function fetchPackument(fetchFn: typeof fetch = fetch): Promise<Packument> {
  const res = await fetchFn(`${registryUrl()}/${PACKAGE_NAME}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`registry responded ${res.status}`);
  }
  return (await res.json()) as Packument;
}

/** Newest version that has cleared the bake period and is newer than the running one, or null. */
export async function findEligibleUpdate(now = Date.now(), fetchFn?: typeof fetch): Promise<string | null> {
  return selectUpdate(await fetchPackument(fetchFn), { current: PACKAGE_VERSION, now });
}

export interface InstallDeps {
  spawnFn?: typeof spawn;
  /** Whether the user's npm config already sets its own release-age/`before` bake. */
  userHasBake?: () => Promise<boolean>;
}

/** Value of `npm config get <key>`, or undefined when unset or npm doesn't know the key. */
function npmConfigValue(key: string, spawnFn: typeof spawn): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { cmd, spawnArgs, windowsVerbatimArguments } = resolveWrapSpawn('npm', ['config', 'get', key]);
    try {
      const child = spawnFn(cmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: neutralCwd(),
        windowsHide: true,
        timeout: NPM_CONFIG_TIMEOUT_MS,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
      });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('error', () => resolve(undefined));
      child.on('close', () => {
        const v = out.trim();
        resolve(v === '' || v === 'undefined' || v === 'null' || v === '0' ? undefined : v);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function npmConfigHasBake(spawnFn: typeof spawn): Promise<boolean> {
  const values = await Promise.all([npmConfigValue('min-release-age', spawnFn), npmConfigValue('before', spawnFn)]);
  return values.some((v) => v !== undefined);
}

/**
 * `npm install -g <pkg>@<exact version>`; resolves true on a zero exit. Pinned so the bake check is what
 * gets installed, and `--before` holds every transitive dependency to the same 48-hour bake. If the user's
 * npm config already sets `min-release-age` or `before`, ours is left off: npm rejects combining them, and
 * their own bake then covers the dependencies.
 */
export async function installVersion(
  version: string,
  stdio: StdioOptions = 'ignore',
  deps: InstallDeps = {}
): Promise<boolean> {
  const spawnFn = deps.spawnFn ?? spawn;
  // When the version was chosen from an overridden registry, install from that same one so the
  // bake check and the installed bits agree; otherwise defer to the user's own npm config.
  // Resolved first so an invalid override fails before any child process starts.
  const registry = registryOverride();
  const userBake = await (deps.userHasBake ?? (() => npmConfigHasBake(spawnFn)))();
  const { cmd, spawnArgs, windowsVerbatimArguments } = resolveWrapSpawn('npm', [
    'install',
    '-g',
    ...(registry ? ['--registry', registry] : []),
    ...(userBake ? [] : [`--before=${new Date(Date.now() - BAKE_PERIOD_MS).toISOString()}`]),
    `${PACKAGE_NAME}@${version}`,
  ]);
  return new Promise((resolve) => {
    try {
      const child = spawnFn(cmd, spawnArgs, {
        stdio,
        cwd: neutralCwd(),
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

export function manualInstallHint(version: string): string {
  return `npm install -g ${PACKAGE_NAME}@${version}`;
}

/** How to update by hand; softened when this copy isn't a global npm install, where that command would add a second copy. */
export function updateHint(version: string): string {
  return canSelfInstall()
    ? `Run \`${manualInstallHint(version)}\` to update.`
    : `Update with the package manager you installed it with (for npm: \`${manualInstallHint(version)}\`).`;
}

/** Version in the package.json of the install the running script belongs to, or undefined if it can't be read. */
export function installedVersionOnDisk(): string | undefined {
  const script = runningScript();
  if (!script) {
    return undefined;
  }
  for (let dir = path.dirname(script); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME) {
        return pkg.version;
      }
    } catch {
      // keep walking up
    }
  }
  return undefined;
}

export interface BackgroundDeps {
  selfInstall?: boolean;
  install?: (version: string) => Promise<boolean>;
  versionOnDisk?: () => string | undefined;
  fetchFn?: typeof fetch;
}

/**
 * Hidden `__auto-update` command, run detached by `maybeAutoUpdate`. Checks the registry and, for a
 * global npm install, installs the eligible version; otherwise records it so the next launch can
 * mention it. Network and install failures are swallowed. A version whose install failed is not
 * retried (a newer one is, and so is that version after a week), so a root-owned prefix doesn't re-run `npm install -g` every day.
 */
export async function run(deps: BackgroundDeps = {}): Promise<number> {
  // Two launches past the daily interval can both spawn this job; only one may touch the global install.
  const release = await acquireLock();
  if (!release) {
    return ExitCode.OK;
  }
  try {
    return await runLocked(deps);
  } finally {
    // On Windows an antivirus/indexer can briefly hold the lock file; a stale lock is taken over later anyway.
    await release().catch(() => undefined);
  }
}

async function runLocked(deps: BackgroundDeps): Promise<number> {
  const checkedAt = new Date().toISOString();
  // Fields this job owns; merged into a freshly re-read state at the end, because the install can take
  // minutes and foreground launches write `notified`/`last_check` in the meantime.
  const update: Pick<UpdateState, 'available' | 'installed' | 'failed'> = {};
  let found = false;
  try {
    const priorFailed = (await loadState()).failed;
    const target = selectUpdate(await fetchPackument(deps.fetchFn), { current: PACKAGE_VERSION, now: Date.now() });
    found = true;
    if (target) {
      update.available = target;
      const failedAt = priorFailed ? Date.parse(priorFailed.at) : NaN;
      if (priorFailed?.version === target && Date.now() - failedAt < FAILED_RETRY_MS) {
        update.failed = priorFailed;
      } else if (deps.selfInstall ?? canSelfInstall()) {
        const ok = await (deps.install ?? installVersion)(target);
        // Only trust the install if the files for the running copy now say so; npm may have
        // targeted a different global prefix than the one holding this script.
        if (ok && (deps.versionOnDisk ?? installedVersionOnDisk)() === target) {
          update.installed = target;
          delete update.available;
        } else {
          update.failed = { version: target, at: new Date().toISOString() };
        }
      }
    }
  } catch {
    // Offline or registry hiccup.
  }
  const state = await loadState();
  state.last_check = checkedAt;
  if (found) {
    delete state.available;
    delete state.failed;
    Object.assign(state, update);
  }
  await saveState(state);
  return ExitCode.OK;
}

interface SpawnDeps {
  spawnFn?: typeof spawn;
}

function spawnBackgroundUpdate(deps: SpawnDeps = {}): void {
  const spawnFn = deps.spawnFn ?? spawn;
  const cliPath = process.argv[1];
  if (!cliPath) {
    return;
  }
  try {
    const child = spawnFn(process.execPath, [cliPath, '__auto-update'], {
      detached: true,
      stdio: 'ignore',
      cwd: neutralCwd(),
      // The child runs from another cwd, so hand it the absolute config dir a relative override would break.
      env: { ...process.env, COOLHAND_CONFIG_DIR: path.resolve(configDir()) },
      windowsHide: true,
    });
    child.on('error', () => {
      // Best-effort; the next launch past the interval tries again.
    });
    child.unref();
  } catch {
    // Same: never let the updater break the command the user asked for.
  }
}

/**
 * Called at the start of every command. Costs one small file read: it announces a finished or
 * pending update (once, on stderr) and, at most daily, launches the detached background check.
 * Quiet under `--json`, in CI, and when opted out (`COOLHAND_NO_AUTO_UPDATE=1` or `auto_update: false`
 * in config.json). Best-effort — never throws.
 */
export async function maybeAutoUpdate(
  opts: { command: string | undefined; json: boolean },
  deps: SpawnDeps & { now?: number; ownScript?: boolean } = {}
): Promise<void> {
  try {
    const passive = opts.command === undefined || NO_AUTO_UPDATE.has(opts.command) || opts.command.startsWith('-');
    if (passive || optedOutByEnv()) {
      return;
    }
    // `run` is a public export: a host program embedding it must not have its own script re-executed.
    if (!(deps.ownScript ?? installedVersionOnDisk() !== undefined)) {
      return;
    }
    if ((await loadConfig()).auto_update === false) {
      return;
    }
    const now = deps.now ?? Date.now();
    const state = await loadState();
    let dirty = false;

    const current = parseStable(PACKAGE_VERSION);
    const installed = state.installed ? parseStable(state.installed) : null;
    if (state.installed && current && installed && compareSemver(current, installed) >= 0) {
      // Under --json the announcement is deferred (kept) rather than lost, unless it's already stale.
      if (!opts.json && state.installed === PACKAGE_VERSION) {
        logger.info(`${PACKAGE_NAME} updated to ${state.installed}.`);
      }
      if (!opts.json || state.installed !== PACKAGE_VERSION) {
        delete state.installed;
        dirty = true;
      }
    }

    const available = state.available ? parseStable(state.available) : null;
    if (state.available && current && available && compareSemver(available, current) > 0) {
      if (!opts.json && state.notified !== state.available) {
        logger.info(
          `${PACKAGE_NAME} ${state.available} is available. ${updateHint(state.available)}`
        );
        state.notified = state.available;
        dirty = true;
      }
    }

    const last = state.last_check ? Date.parse(state.last_check) : NaN;
    // A last_check in the future (clock change, hand-edited file) must not suppress checks indefinitely.
    const due = Number.isNaN(last) || last > now || now - last >= CHECK_INTERVAL_MS;
    if (due) {
      // Stamp before spawning so concurrent launches don't each start a check.
      state.last_check = new Date(now).toISOString();
      dirty = true;
    }
    if (dirty) {
      await saveState(state);
    }
    if (due) {
      spawnBackgroundUpdate(deps);
    }
  } catch {
    // Never let the updater break the command the user asked for.
  }
}

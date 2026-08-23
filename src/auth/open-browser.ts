import { spawn } from 'child_process';
import { logger } from '../logger.js';
import { resolveWrapSpawn } from '../win-spawn.js';

interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}

export async function openBrowser(url: string, deps: OpenBrowserDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? spawn;

  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const { cmd, spawnArgs, windowsVerbatimArguments } = resolveWrapSpawn(command, args, platform);

  try {
    const child = spawnFn(cmd, spawnArgs, { detached: true, stdio: 'ignore', windowsVerbatimArguments });
    child.on('error', (err) => {
      logger.warn(`Failed to open browser (${command}): ${err.message}. Open the URL manually.`);
    });
    child.unref();
  } catch (err) {
    logger.warn(`Failed to launch browser (${command}): ${(err as Error).message}. Open the URL manually.`);
  }
}

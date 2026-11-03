import {
  canSelfInstall,
  findEligibleUpdate,
  installedVersionOnDisk,
  installVersion,
  manualInstallHint,
  updateHint,
} from '../auto-update/index.js';
import { CliError, ExitCode } from '../errors.js';
import { logger } from '../logger.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import type { UpdateOptions } from '../types.js';

export interface UpdateDeps {
  selfInstall?: boolean;
  install?: typeof installVersion;
  versionOnDisk?: () => string | undefined;
}

export async function run(opts: UpdateOptions, deps: UpdateDeps = {}): Promise<number> {
  let target: string | null;
  try {
    target = await findEligibleUpdate();
  } catch (err) {
    throw new CliError('UPDATE_ERROR', `Could not check the npm registry: ${(err as Error).message}`);
  }

  if (!target) {
    if (opts.json) {
      logger.json({ current: PACKAGE_VERSION, target: null, installed: false });
    } else {
      logger.info(
        `${PACKAGE_NAME} ${PACKAGE_VERSION} has no newer eligible release ` +
          '(only stable, non-deprecated releases at least 48 hours old and not above the `latest` tag are installed).'
      );
    }
    return ExitCode.OK;
  }

  const install = !opts.check && (deps.selfInstall ?? canSelfInstall());
  if (!install) {
    if (opts.json) {
      logger.json({ current: PACKAGE_VERSION, target, installed: false });
    } else {
      logger.info(`${PACKAGE_NAME} ${target} is available (you have ${PACKAGE_VERSION}). ${updateHint(target)}`);
    }
    return ExitCode.OK;
  }

  logger.info(`Updating ${PACKAGE_NAME} ${PACKAGE_VERSION} → ${target}…`);
  // Keep npm's stdout out of --json output so it stays parseable; npm's errors still reach stderr.
  const ok = await (deps.install ?? installVersion)(target, opts.json ? ['ignore', 'ignore', 'inherit'] : 'inherit');
  if (!ok) {
    throw new CliError('UPDATE_ERROR', `\`${manualInstallHint(target)}\` failed. You may need to run it with different permissions.`);
  }
  // npm on PATH may have installed into a different global prefix than this copy lives in.
  if ((deps.versionOnDisk ?? installedVersionOnDisk)() !== target) {
    throw new CliError(
      'UPDATE_ERROR',
      `npm reported success, but this copy of ${PACKAGE_NAME} is still ${PACKAGE_VERSION}; npm may be installing to a different global prefix. Check \`npm prefix -g\`.`
    );
  }
  if (opts.json) {
    logger.json({ current: PACKAGE_VERSION, target, installed: true });
  } else {
    logger.info(`Updated to ${target}.`);
  }
  return ExitCode.OK;
}

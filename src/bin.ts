#!/usr/bin/env node
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { logger, redact } from './logger.js';

run(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.info(`Unexpected error: ${redact(message)}`);
    process.exit(ExitCode.INTERNAL);
  });

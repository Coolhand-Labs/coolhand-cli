import type { HelpCategory } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getHelpCenterClient, mapHelpCenterHttpError } from '../api/help-center-client.js';
import type { ListHelpCategoriesOptions } from '../types.js';

function printCategory(c: HelpCategory): void {
  logger.info(`${c.slug} — ${c.name} (${c.url_prefix})`);
  if (c.description) {
    logger.info(`  ${c.description}`);
  }
  if (c.allowed_tags) {
    logger.info(`  Allowed tags: ${c.allowed_tags.join(', ')}`);
  }
}

export async function run(opts: ListHelpCategoriesOptions): Promise<number> {
  try {
    const client = await getHelpCenterClient({ clientId: opts.clientId, baseUrl: opts.baseUrl });

    let categories: HelpCategory[];
    try {
      categories = await client.service.listHelpCategories();
    } catch (err) {
      throw mapHelpCenterHttpError(err, client, 'Help center categories not found.');
    }

    if (opts.json) {
      logger.json({ ok: true, result: categories });
    } else {
      for (const category of categories) {
        printCategory(category);
      }
      logger.info('\nFilter a search by section: coolhand search-help-articles --category <slug>');
    }
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CliError) {
      if (opts.json) {
        logger.json({ ok: false, error: err.code, message: redact(err.message) });
      } else {
        logger.info(`Error: ${redact(err.message)} [${err.code}]`);
      }
      return err.exitCode;
    }
    throw err;
  }
}

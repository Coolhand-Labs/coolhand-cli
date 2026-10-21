import type { HelpArticle } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getHelpCenterClient, mapHelpCenterHttpError } from '../api/help-center-client.js';
import type { GetHelpArticleOptions } from '../types.js';

function printArticle(a: HelpArticle): void {
  logger.info(`Title: ${a.title}`);
  logger.info(`Slug: ${a.slug}`);
  logger.info(`Section: ${a.category}`);
  logger.info(`Kind: ${a.article_kind}`);
  if (a.tags.length > 0) {
    logger.info(`Tags: ${a.tags.join(', ')}`);
  }
  logger.info(`URL: ${a.url}`);
  if (a.updated_content_at) {
    logger.info(`Updated: ${a.updated_content_at}`);
  }
  logger.info(`\n${a.body}`);
}

export async function run(opts: GetHelpArticleOptions): Promise<number> {
  try {
    const client = await getHelpCenterClient({ clientId: opts.clientId, baseUrl: opts.baseUrl });

    let article: HelpArticle;
    try {
      article = await client.service.getHelpArticle(opts.slug);
    } catch (err) {
      throw mapHelpCenterHttpError(err, client, `Help article "${opts.slug}" not found (unknown or unpublished slug).`);
    }

    if (opts.json) {
      logger.json({ ok: true, result: article });
    } else {
      printArticle(article);
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

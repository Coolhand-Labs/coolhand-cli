import type { HelpArticleSummary, SearchHelpArticlesParams, SearchHelpArticlesResponse } from 'coolhand-node';
import { CliError, ExitCode } from '../errors.js';
import { logger, redact } from '../logger.js';
import { getHelpCenterClient, mapHelpCenterHttpError } from '../api/help-center-client.js';
import type { SearchHelpArticlesOptions } from '../types.js';

const MAX_PASSAGE_CHARS = 160;

function passage(headline: string): string {
  const flat = headline.replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_PASSAGE_CHARS ? `${flat.slice(0, MAX_PASSAGE_CHARS)}…` : flat;
}

function printArticle(a: HelpArticleSummary, hasQuery: boolean): void {
  logger.info(`${a.slug} — ${a.title} [${a.article_kind}, ${a.category}]`);
  if (a.answer) {
    logger.info(`  ${a.answer}`);
  }
  if (hasQuery && a.search_headline) {
    logger.info(`  …${passage(a.search_headline)}`);
  }
  logger.info(`  ${a.url}`);
}

export async function run(opts: SearchHelpArticlesOptions): Promise<number> {
  try {
    const client = await getHelpCenterClient({ clientId: opts.clientId, baseUrl: opts.baseUrl });

    const params: SearchHelpArticlesParams = {};
    if (opts.query !== undefined) {
      params.query = opts.query;
    }
    if (opts.category !== undefined) {
      params.category = opts.category;
    }
    if (opts.page !== undefined) {
      params.page = opts.page;
    }
    if (opts.perPage !== undefined) {
      params.perPage = opts.perPage;
    }

    let result: SearchHelpArticlesResponse;
    try {
      result = await client.service.searchHelpArticles(params);
    } catch (err) {
      throw mapHelpCenterHttpError(err, client, 'Help center search failed.');
    }

    if (opts.json) {
      logger.json({ ok: true, result });
    } else {
      const { articles, pagination } = result;
      logger.info(
        `Page ${pagination.current_page} of ${pagination.total_pages} (${pagination.total_count} total) — use --page N to navigate`
      );
      if (articles.length === 0) {
        logger.info('No help articles matched.');
      }
      for (const article of articles) {
        printArticle(article, opts.query !== undefined);
      }
      if (articles.length > 0) {
        logger.info('\nRead one in full: coolhand get-help-article <slug>');
      }
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

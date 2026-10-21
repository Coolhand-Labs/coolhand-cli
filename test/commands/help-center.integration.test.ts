import http from 'http';
import { AddressInfo } from 'net';
import { run as runSearch } from '../../src/commands/search-help-articles.js';
import { run as runGet } from '../../src/commands/get-help-article.js';
import { run as runCategories } from '../../src/commands/list-help-categories.js';
import { upsertClient } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

/**
 * Real-transport proof: no SDK mock. A local HTTP server stands in for `/api/v2/public_content`
 * and each command runs through the real `coolhand-node` `PublicContentService`, so the wire
 * format (query string, `X-API-Key` header, pagination headers, status handling) is asserted as
 * the server would see it.
 */

const BASE = '/api/v2/public_content';

interface Seen {
  url: URL;
  apiKey: string | undefined;
}

interface FakeServer {
  url: string;
  seen: Seen[];
  respond: (status: number, body: unknown, headers?: Record<string, string>) => void;
  close(): Promise<void>;
}

const summary = {
  slug: 'anthropic-api-best-practices',
  title: 'Anthropic API best practices',
  answer: 'Send the system prompt in the top-level field.',
  article_kind: 'reference',
  tags: ['providers'],
  category: 'providers',
  url: 'https://coolhandlabs.com/help/anthropic-api-best-practices',
  markdown_url: 'https://coolhandlabs.com/help/anthropic-api-best-practices.md',
  reading_time_minutes: 5,
  search_headline: '<mark>Anthropic</mark> carries the system prompt',
  published_at: '2026-08-30T13:57:51Z',
  updated_content_at: null,
};

const article = { ...summary, search_headline: undefined, body: '# Anthropic\n\nBody text.', noindex: false, toc: [] };

async function startFakeCoolhand(): Promise<FakeServer> {
  const seen: Seen[] = [];
  let reply: { status: number; body: unknown; headers: Record<string, string> } | undefined;
  const server = http.createServer((req, res) => {
    seen.push({
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      apiKey: req.headers['x-api-key'] as string | undefined,
    });
    const r = reply ?? { status: 200, body: [], headers: {} };
    res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    respond: (status, body, headers = {}) => {
      reply = { status, body, headers };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const pageHeaders = { 'X-Page': '2', 'X-Per-Page': '10', 'X-Total-Count': '25', 'X-Total-Pages': '3' };

describe('help center commands over a real HTTP transport', () => {
  let home: TmpHome;
  let server: FakeServer;
  let jsonSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let savedKey: string | undefined;

  const jsonOut = (): Array<{ ok: boolean; result?: unknown; error?: string; message?: string }> =>
    jsonSpy.mock.calls.map(([payload]) => payload);
  const infoOut = (): string => infoSpy.mock.calls.map(([msg]) => msg).join('\n');

  beforeEach(async () => {
    home = await createTmpHome();
    server = await startFakeCoolhand();
    jsonSpy = jest.spyOn(logger, 'json').mockImplementation(() => {});
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    // PublicContentService falls back to COOLHAND_API_KEY, which would defeat the no-key cases.
    savedKey = process.env.COOLHAND_API_KEY;
    delete process.env.COOLHAND_API_KEY;
  });

  afterEach(async () => {
    jsonSpy.mockRestore();
    infoSpy.mockRestore();
    if (savedKey !== undefined) {
      process.env.COOLHAND_API_KEY = savedKey;
    }
    await server.close();
    await home.cleanup();
  });

  test('anonymous list: no stored client, no X-API-Key header, bare listing', async () => {
    server.respond(200, [summary], pageHeaders);
    const code = await runSearch({ baseUrl: server.url, json: true });
    expect(code).toBe(0);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].url.pathname).toBe(BASE);
    expect(server.seen[0].url.search).toBe('');
    expect(server.seen[0].apiKey).toBeUndefined();
    expect(jsonOut()[0]).toMatchObject({
      ok: true,
      result: {
        articles: [{ slug: 'anthropic-api-best-practices' }],
        pagination: { current_page: 2, per_page: 10, total_count: 25, total_pages: 3 },
      },
    });
  });

  test('query search sends q and prints the page header, article and passage', async () => {
    server.respond(200, [summary], pageHeaders);
    const code = await runSearch({ baseUrl: server.url, query: 'anthropic', page: 2, perPage: 10 });
    expect(code).toBe(0);
    expect(server.seen[0].url.searchParams.get('q')).toBe('anthropic');
    expect(server.seen[0].url.searchParams.get('page')).toBe('2');
    expect(server.seen[0].url.searchParams.get('per_page')).toBe('10');
    const out = infoOut();
    expect(out).toContain('Page 2 of 3 (25 total)');
    expect(out).toContain('anthropic-api-best-practices — Anthropic API best practices');
    expect(out).toContain('Anthropic carries the system prompt');
    expect(out).not.toContain('<mark>');
  });

  test('category alone is sent in the structured q[help_category_slug_eq] form', async () => {
    server.respond(200, [summary], pageHeaders);
    await runSearch({ baseUrl: server.url, category: 'providers' });
    const params = server.seen[0].url.searchParams;
    expect(params.get('q[help_category_slug_eq]')).toBe('providers');
    expect(params.has('q')).toBe(false);
    expect(params.has('category')).toBe(false);
    expect(params.has('corpus')).toBe(false);
  });

  test('category plus query moves the text to q[full_text]', async () => {
    server.respond(200, [summary], pageHeaders);
    await runSearch({ baseUrl: server.url, category: 'providers', query: 'anthropic' });
    const params = server.seen[0].url.searchParams;
    expect(params.get('q[help_category_slug_eq]')).toBe('providers');
    expect(params.get('q[full_text]')).toBe('anthropic');
    expect(params.has('q')).toBe(false);
  });

  test('show by slug returns the article including its markdown body', async () => {
    server.respond(200, article);
    const code = await runGet({ baseUrl: server.url, slug: 'anthropic-api-best-practices' });
    expect(code).toBe(0);
    expect(server.seen[0].url.pathname).toBe(`${BASE}/anthropic-api-best-practices`);
    expect(server.seen[0].apiKey).toBeUndefined();
    expect(infoOut()).toContain('Body text.');
  });

  test('show --json emits the article as the result', async () => {
    server.respond(200, article);
    await runGet({ baseUrl: server.url, slug: 'anthropic-api-best-practices', json: true });
    expect(jsonOut()[0]).toMatchObject({ ok: true, result: { slug: 'anthropic-api-best-practices', body: '# Anthropic\n\nBody text.' } });
  });

  test('show of an unknown slug is a 404 reported as an error with exit 1', async () => {
    server.respond(404, { error: 'Not found' });
    const code = await runGet({ baseUrl: server.url, slug: 'nope', json: true });
    expect(code).toBe(1);
    expect(jsonOut()[0]).toMatchObject({ ok: false, error: 'HELP_CENTER_ERROR' });
    expect(jsonOut()[0].message).toContain('"nope" not found');
  });

  test('categories lists sections with their allowed tags', async () => {
    server.respond(200, [
      { slug: 'providers', name: 'Provider guides', description: 'Guides.', url_prefix: '/help', allowed_tags: null },
      { slug: 'updates', name: 'Product updates', description: 'News.', url_prefix: '/updates', allowed_tags: ['open_source'] },
    ]);
    const code = await runCategories({ baseUrl: server.url });
    expect(code).toBe(0);
    expect(server.seen[0].url.pathname).toBe(`${BASE}/categories`);
    const out = infoOut();
    expect(out).toContain('providers — Provider guides (/help)');
    expect(out).toContain('Allowed tags: open_source');
  });

  describe('with a stored client', () => {
    beforeEach(async () => {
      await upsertClient({
        client_id: 'client-1',
        client_name: 'Test Client',
        api_key: 'pub_key_123',
        private_key: 'priv_key_123',
        base_url: server.url,
        saved_at: new Date().toISOString(),
      });
    });

    test('sends the stored key as X-API-Key without needing a flag', async () => {
      server.respond(200, [summary], pageHeaders);
      const code = await runSearch({ json: true });
      expect(code).toBe(0);
      expect(server.seen[0].apiKey).toBe('pub_key_123');
    });

    test('does not send the stored key to a different --base-url', async () => {
      const other = await startFakeCoolhand();
      try {
        other.respond(200, []);
        await runSearch({ baseUrl: other.url });
        expect(other.seen).toHaveLength(1);
        expect(other.seen[0].apiKey).toBeUndefined();
        expect(server.seen).toHaveLength(0);
      } finally {
        await other.close();
      }
    });

    test('an invalid stored key (401) is reported as an error and not retried anonymously', async () => {
      server.respond(401, { error: 'Invalid API key.' });
      const code = await runSearch({ json: true });
      expect(code).toBe(1);
      expect(server.seen).toHaveLength(1);
      expect(jsonOut()[0]).toMatchObject({ ok: false, error: 'HELP_CENTER_ERROR' });
      expect(jsonOut()[0].message).toContain('coolhand login');
    });
  });

  test('the anonymous rate limit (429) is reported with a wait-and-retry message', async () => {
    server.respond(429, { error: 'Rate limit exceeded' });
    const code = await runSearch({ baseUrl: server.url, json: true });
    expect(code).toBe(1);
    expect(jsonOut()[0].message).toContain('Wait a minute');
  });

  test('an unreachable server is a HELP_CENTER_ERROR, not a crash', async () => {
    const url = server.url;
    await server.close();
    server = await startFakeCoolhand();
    const code = await runCategories({ baseUrl: url, json: true });
    expect(code).toBe(1);
    expect(jsonOut()[0]).toMatchObject({ ok: false, error: 'HELP_CENTER_ERROR' });
  });

  test('a non-loopback http base URL is rejected as INVALID_BASE_URL', async () => {
    const code = await runCategories({ baseUrl: 'http://example.com', json: true });
    expect(code).toBe(1);
    expect(jsonOut()[0]).toMatchObject({ ok: false, error: 'INVALID_BASE_URL' });
  });
});

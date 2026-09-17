/**
 * Behavioural tests for the OUTBOUND WEB tools: web_fetch, web_search,
 * web_search_pro, web_map and web_crawl.
 *
 * These are the tools that let a model choose a URL or spend the owner's
 * provider credit, so what is worth pinning is the order of the guards in
 * front of the network, not the parsing behind it (extractCitations and
 * relPathForUrl already have their own unit tests):
 *
 *  - a private, loopback or cloud-metadata target is refused BEFORE fetch is
 *    called, and the refusal names the reason. For web_fetch the REAL egress
 *    guard runs against a stubbed global fetch; a redirect into private space
 *    must stop at the hop, not at the destination.
 *  - a missing provider key comes back as a tool error that points at
 *    /settings/keys, without a client ever being constructed; a provider
 *    failure comes back as a tool error, never a throw.
 *  - web_map / web_crawl refuse the team surfaces first, and a crawl that
 *    returned nothing never creates a collection.
 *  - what IS stored (crawl pages, the collection) is scoped to ctx.ownerId,
 *    and the collection is created disabled so the docs-sync watcher ignores
 *    it.
 *  - the success arm's output shape, which the responder and the researcher
 *    agent read back.
 *
 * Public targets are literal IPs (no DNS lookup, so nothing here resolves a
 * real host), and fetch / OpenRouter / Firecrawl are all stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  /** Where clauses handed to the selects, in call order. A `mockReturnThis()`
   *  where asserts nothing, so owner scoping is read out of these instead. */
  const selectWheres: unknown[] = [];
  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      selectWheres.push(clause);
      return this;
    }),
    limit,
  };
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    selectQueue,
    selectWheres,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: updateSet })),
    // OpenRouter: constructor args + the one method web_search calls.
    orCtor: vi.fn(),
    send: vi.fn(),
    // Firecrawl: constructor args + the two methods the crawl tools call.
    fcCtor: vi.fn(),
    fcMap: vi.fn(),
    fcCrawl: vi.fn(),
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    db: { ...actual.db, select: h.select, update: h.update },
    getDefaultWorker: vi.fn(),
    bumpWorkerUsage: vi.fn(),
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, loadProfilePreferences: vi.fn() };
});
vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return { ...actual, listApiKeys: vi.fn(), getApiKey: vi.fn(), getApiKeyById: vi.fn() };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    parseTikaBytes: vi.fn(),
    createDocCollection: vi.fn(),
    upsertDocFromDisk: vi.fn(),
  };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return { ...actual, recordIngest: vi.fn(), captureLlmUsage: vi.fn() };
});
vi.mock('./crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crud')>();
  return { ...actual, createTool: vi.fn(), updateTool: vi.fn(), listToolsForOwner: vi.fn() };
});
vi.mock('./integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration')>();
  return {
    ...actual,
    getGroupIntegration: vi.fn(),
    setGroupIntegration: vi.fn(),
    upsertApiDocsFile: vi.fn(),
  };
});
vi.mock('./dispatch-bridge', () => ({
  dispatchViaBridge: vi.fn(),
  registerToolDispatcher: vi.fn(),
}));
vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    chat = { send: h.send };
    constructor(opts: unknown) {
      h.orCtor(opts);
    }
  },
}));
vi.mock('firecrawl', () => ({
  Firecrawl: class {
    map = h.fcMap;
    crawl = h.fcCrawl;
    constructor(opts: unknown) {
      h.fcCtor(opts);
    }
  },
}));

import { bumpWorkerUsage, getDefaultWorker } from '@mantle/db';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import { createDocCollection, parseTikaBytes, upsertDocFromDisk } from '@mantle/files';
import { captureLlmUsage, recordIngest } from '@mantle/tracing';
import { paramsOf } from './test-support';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import { RESEARCH_TOOLS } from './builtins-research';
import { CRAWL_TOOLS } from './builtins-crawl';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const webFetch = TOOLSMITH_TOOLS.find((t) => t.slug === 'web_fetch')!;
const webSearch = RESEARCH_TOOLS.find((t) => t.slug === 'web_search')!;
const webSearchPro = RESEARCH_TOOLS.find((t) => t.slug === 'web_search_pro')!;
const webMap = CRAWL_TOOLS.find((t) => t.slug === 'web_map')!;
const webCrawl = CRAWL_TOOLS.find((t) => t.slug === 'web_crawl')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const TEAM_CTX: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };

/** A public literal IP: passes the egress guard with no DNS lookup, and the
 *  stubbed fetch means nothing ever connects to it. */
const PUBLIC = 'http://93.184.216.34/docs';
const METADATA = 'http://169.254.169.254/latest/meta-data/';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const realFetch = global.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function textResponse(body: string, contentType = 'text/plain', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.selectWheres.length = 0;
  fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
  vi.mocked(getDefaultWorker).mockResolvedValue(null);
  vi.mocked(getApiKey).mockResolvedValue(null);
  vi.mocked(getApiKeyById).mockResolvedValue(null);
  vi.mocked(parseTikaBytes).mockResolvedValue('');
  h.send.mockResolvedValue({
    choices: [{ message: { content: 'The answer' } }],
    citations: ['https://a.example/source'],
  });
  h.fcMap.mockResolvedValue({ links: [] });
  h.fcCrawl.mockResolvedValue({ status: 'completed', data: [] });
  vi.mocked(createDocCollection).mockResolvedValue({ collection: COLLECTION } as never);
  vi.mocked(upsertDocFromDisk).mockResolvedValue({ status: 'inserted' } as never);
});

afterEach(() => {
  global.fetch = realFetch;
});

/* ─────────────────────────────── web_fetch ─────────────────────────────── */

describe('web_fetch', () => {
  it('refuses a non-http url before any fetch', async () => {
    expect(errorOf(await webFetch.handler({ url: 'ftp://x/y' }, ctx))).toMatch(
      /url must start with http\(s\)/,
    );
    expect(errorOf(await webFetch.handler({ url: '' }, ctx))).toMatch(/url must start with/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['the cloud-metadata address', METADATA, '169.254.169.254'],
    ['loopback', 'http://127.0.0.1:5432/', '127.0.0.1'],
    ['IPv6 loopback', 'http://[::1]/', '::1'],
    ['a private range', 'http://10.0.0.5/admin', '10.0.0.5'],
  ])('never opens a socket to %s and names the address', async (_label, url, host) => {
    // The real egress guard runs; only the socket layer is stubbed.
    const err = errorOf(await webFetch.handler({ url }, ctx));
    expect(err).toMatch(/private\/internal address/);
    expect(err).toContain(host);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops a redirect INTO private space at the hop, not at the destination', async () => {
    // A public page that 302s to an internal service. The first hop is
    // allowed; the second must be refused before fetch is asked for it.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } }),
    );
    const err = errorOf(await webFetch.handler({ url: PUBLIC }, ctx));
    expect(err).toMatch(/private\/internal address \(10\.0\.0\.5\)/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(PUBLIC);
  });

  it('fetches with manual redirects and an identifying user-agent', async () => {
    fetchSpy.mockResolvedValue(textResponse('ok'));
    await webFetch.handler({ url: PUBLIC }, ctx);
    expect(fetchSpy).toHaveBeenCalledWith(
      PUBLIC,
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ 'user-agent': expect.stringMatching(/mantle/) }),
      }),
    );
  });

  it('returns non-html text as-is with the paging fields', async () => {
    fetchSpy.mockResolvedValue(textResponse('{"a":1}', 'application/json'));
    const out = outputOf(await webFetch.handler({ url: PUBLIC }, ctx));
    expect(out).toEqual({
      url: PUBLIC,
      status: 200,
      contentType: 'application/json',
      text: '{"a":1}',
      totalChars: 7,
      offset: 0,
      truncated: false,
    });
    expect(parseTikaBytes).not.toHaveBeenCalled();
  });

  it('sends html through Tika and falls back to the crude stripper when Tika is empty', async () => {
    const html = '<html><body><script>x()</script><p>Hi &amp; bye</p></body></html>';
    // A fresh Response per call: a body can only be read once.
    fetchSpy.mockImplementation(async () => textResponse(html, 'text/html; charset=utf-8'));
    const out = outputOf(await webFetch.handler({ url: PUBLIC }, ctx));
    expect(parseTikaBytes).toHaveBeenCalledWith(expect.any(Buffer), { mimeType: 'text/html' });
    expect(out.text).toBe('Hi & bye');

    vi.mocked(parseTikaBytes).mockResolvedValue('Tika text');
    expect(outputOf(await webFetch.handler({ url: PUBLIC }, ctx)).text).toBe('Tika text');
  });

  it('pages with offset and max_chars (floored at 1000) and flags truncation', async () => {
    fetchSpy.mockResolvedValue(textResponse('a'.repeat(5000)));
    const out = outputOf(await webFetch.handler({ url: PUBLIC, offset: 1000, max_chars: 5 }, ctx));
    expect((out.text as string).length).toBe(1000);
    expect(out).toMatchObject({ offset: 1000, totalChars: 5000, truncated: true });
  });

  it('reports a network failure as a tool error, not a throw', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    expect(errorOf(await webFetch.handler({ url: PUBLIC }, ctx))).toBe('ECONNRESET');
  });
});

/* ───────────────────────── web_search / web_search_pro ─────────────────── */

const SEARCH_WORKER = {
  id: 'w1',
  slug: 'sonar',
  provider: 'openrouter',
  model: 'perplexity/sonar',
  apiKeyId: 'k1',
  params: { recency: 'week', max_tokens: 500 },
};

describe('web_search', () => {
  it('refuses a blank query before resolving a worker or key', async () => {
    expect(errorOf(await webSearch.handler({ query: '  ' }, ctx))).toBe('query is required');
    expect(getDefaultWorker).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('reports a missing OpenRouter key as a tool error without building a client', async () => {
    const err = errorOf(await webSearch.handler({ query: 'q' }, ctx));
    expect(err).toMatch(/no openrouter API key configured/);
    expect(err).toMatch(/\/settings\/keys/);
    expect(h.orCtor).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("uses the worker's pinned key first, then the owner's default label, then any row", async () => {
    vi.mocked(getDefaultWorker).mockResolvedValue(SEARCH_WORKER as never);
    vi.mocked(getApiKeyById).mockResolvedValue('sk-worker');
    await webSearch.handler({ query: 'q' }, ctx);
    expect(getApiKeyById).toHaveBeenCalledWith('k1');
    expect(h.orCtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-worker' }));
    expect(getApiKey).not.toHaveBeenCalled();

    vi.mocked(getDefaultWorker).mockResolvedValue({ ...SEARCH_WORKER, apiKeyId: null } as never);
    vi.mocked(getApiKey).mockResolvedValue('sk-owner');
    await webSearch.handler({ query: 'q' }, ctx);
    expect(getApiKey).toHaveBeenCalledWith('o1', 'openrouter');
    expect(h.orCtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-owner' }));

    vi.mocked(getApiKey).mockResolvedValue(null);
    h.selectQueue.push([{ id: 'k9' }]);
    vi.mocked(getApiKeyById).mockResolvedValue('sk-any');
    await webSearch.handler({ query: 'q' }, ctx);
    expect(getApiKeyById).toHaveBeenLastCalledWith('k9');
    expect(h.orCtor).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-any' }));
  });

  it('sends the worker model with its params, a per-call recency winning', async () => {
    vi.mocked(getDefaultWorker).mockResolvedValue(SEARCH_WORKER as never);
    vi.mocked(getApiKeyById).mockResolvedValue('sk');
    const res = await webSearch.handler({ query: 'latest node lts', recency: 'day' }, ctx);
    expect(h.send).toHaveBeenCalledWith({
      chatRequest: {
        model: 'perplexity/sonar',
        messages: [{ role: 'user', content: 'latest node lts' }],
        usage: { include: true },
        search_recency_filter: 'day',
        max_tokens: 500,
      },
    });
    expect(outputOf(res)).toEqual({
      query: 'latest node lts',
      model: 'perplexity/sonar',
      answer: 'The answer',
      citations: ['https://a.example/source'],
    });
    expect(bumpWorkerUsage).toHaveBeenCalledWith('w1');
  });

  it("falls back to the worker's recency, then to the default model when no worker exists", async () => {
    vi.mocked(getDefaultWorker).mockResolvedValue(SEARCH_WORKER as never);
    vi.mocked(getApiKeyById).mockResolvedValue('sk');
    await webSearch.handler({ query: 'q' }, ctx);
    expect(h.send).toHaveBeenLastCalledWith({
      chatRequest: expect.objectContaining({ search_recency_filter: 'week' }),
    });

    vi.mocked(getDefaultWorker).mockResolvedValue(null);
    vi.mocked(getApiKey).mockResolvedValue('sk');
    vi.mocked(bumpWorkerUsage).mockClear();
    const out = outputOf(await webSearch.handler({ query: 'q' }, ctx));
    expect(out.model).toBe(process.env.MANTLE_WEB_SEARCH_MODEL || 'perplexity/sonar-pro');
    expect(h.send).toHaveBeenLastCalledWith({
      chatRequest: expect.not.objectContaining({ search_recency_filter: expect.anything() }),
    });
    expect(bumpWorkerUsage).not.toHaveBeenCalled();
  });

  it('reports a provider failure as a tool error, not a throw', async () => {
    vi.mocked(getApiKey).mockResolvedValue('sk');
    h.send.mockRejectedValue(new Error('429 rate limited'));
    expect(errorOf(await webSearch.handler({ query: 'q' }, ctx))).toBe('429 rate limited');
  });

  it('reports an empty answer rather than an ok with nothing in it', async () => {
    vi.mocked(getApiKey).mockResolvedValue('sk');
    h.send.mockResolvedValue({ choices: [{ message: { content: '' } }] });
    expect(errorOf(await webSearch.handler({ query: 'q' }, ctx))).toBe(
      'web search returned no answer',
    );
  });

  it('attributes the Sonar call to the active step', async () => {
    vi.mocked(getApiKey).mockResolvedValue('sk');
    const step = { setMeta: vi.fn(), setOutput: vi.fn() };
    await webSearch.handler(
      { query: 'q', recency: 'day' },
      { ownerId: 'o1', step: step as unknown as ToolHandlerContext['step'] },
    );
    expect(captureLlmUsage).toHaveBeenCalledWith(step, expect.any(Object), expect.any(String));
    expect(step.setMeta).toHaveBeenCalledWith({
      tier: 'search',
      recency: 'day',
      citation_count: 1,
    });
    expect(step.setOutput).toHaveBeenCalledWith({ answer_chars: 10, citations: 1 });
  });
});

describe('web_search_pro', () => {
  it('asks for the search_advanced worker and falls back to the standard one', async () => {
    vi.mocked(getDefaultWorker).mockImplementation(
      async (_o, kind) => (kind === 'search' ? SEARCH_WORKER : null) as never,
    );
    vi.mocked(getApiKeyById).mockResolvedValue('sk');
    const out = outputOf(await webSearchPro.handler({ query: 'q' }, ctx));
    expect(getDefaultWorker).toHaveBeenNthCalledWith(1, 'o1', 'search_advanced');
    expect(getDefaultWorker).toHaveBeenNthCalledWith(2, 'o1', 'search');
    expect(out.model).toBe('perplexity/sonar');
  });

  it('prefers the advanced worker when one is configured', async () => {
    const pro = { ...SEARCH_WORKER, id: 'w2', model: 'perplexity/sonar-reasoning-pro' };
    vi.mocked(getDefaultWorker).mockImplementation(
      async (_o, kind) => (kind === 'search_advanced' ? pro : SEARCH_WORKER) as never,
    );
    vi.mocked(getApiKeyById).mockResolvedValue('sk');
    const step = { setMeta: vi.fn(), setOutput: vi.fn() };
    const out = outputOf(
      await webSearchPro.handler(
        { query: 'q' },
        { ownerId: 'o1', step: step as unknown as ToolHandlerContext['step'] },
      ),
    );
    expect(out.model).toBe('perplexity/sonar-reasoning-pro');
    expect(bumpWorkerUsage).toHaveBeenCalledWith('w2');
    expect(step.setMeta).toHaveBeenCalledWith(expect.objectContaining({ tier: 'search_advanced' }));
  });

  it('shares the key and failure handling with web_search', async () => {
    expect(errorOf(await webSearchPro.handler({ query: 'q' }, ctx))).toMatch(
      /no openrouter API key/,
    );
    expect(h.send).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── web_map / web_crawl ─────────────────────── */

const COLLECTION = {
  id: 'col1',
  ownerId: 'o1',
  key: 'crawl-93-184-216-34',
  label: 'Crawl: 93.184.216.34',
  enabled: false,
};

describe('web_map', () => {
  beforeEach(() => {
    vi.mocked(getApiKey).mockResolvedValue('fc-key');
  });

  it.each([
    ['team', { kind: 'team', contactId: 'c1' }],
    ['forum', { kind: 'forum', contactId: 'c1', topicId: 't1' }],
  ])('refuses the %s surface before vetting the url or spending credit', async (_k, surface) => {
    const res = await webMap.handler(
      { url: PUBLIC },
      { ownerId: 'o1', surface: surface as ToolHandlerContext['surface'] },
    );
    expect(errorOf(res)).toMatch(/owner-side tool/);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(h.fcCtor).not.toHaveBeenCalled();
  });

  it('refuses a private target BEFORE resolving a key', async () => {
    // Firecrawl's cloud does the fetching, but the hygiene check still runs
    // first so a metadata address never even reaches the key lookup.
    expect(errorOf(await webMap.handler({ url: METADATA }, ctx))).toMatch(
      /private\/internal address/,
    );
    expect(getApiKey).not.toHaveBeenCalled();
    expect(h.fcCtor).not.toHaveBeenCalled();
  });

  it('refuses a blank or unparseable url', async () => {
    expect(errorOf(await webMap.handler({ url: '  ' }, ctx))).toMatch(/url is required/);
    expect(errorOf(await webMap.handler({ url: 'http://' }, ctx))).toMatch(/not a valid URL/);
    expect(h.fcCtor).not.toHaveBeenCalled();
  });

  it('reports a missing firecrawl key without constructing a client', async () => {
    vi.mocked(getApiKey).mockResolvedValue(null);
    const err = errorOf(await webMap.handler({ url: PUBLIC }, ctx));
    expect(err).toMatch(/no firecrawl API key configured/);
    expect(err).toMatch(/\/settings\/keys/);
    expect(h.fcCtor).not.toHaveBeenCalled();
  });

  it('prefixes https:// on a bare host, forwards the filter and normalises the links', async () => {
    h.fcMap.mockResolvedValue({
      links: ['https://x/a', { url: 'https://x/b', title: 'B' }, { title: 'no url' }],
    });
    const res = await webMap.handler(
      { url: '93.184.216.34/docs', search: 'pricing', limit: 5 },
      ctx,
    );
    expect(h.fcCtor).toHaveBeenCalledWith({ apiKey: 'fc-key' });
    expect(h.fcMap).toHaveBeenCalledWith('https://93.184.216.34/docs', {
      limit: 5,
      search: 'pricing',
    });
    expect(outputOf(res)).toEqual({
      url: 'https://93.184.216.34/docs',
      count: 2,
      links: [{ url: 'https://x/a' }, { url: 'https://x/b', title: 'B' }],
    });
  });

  it('reports a Firecrawl failure as a tool error, not a throw', async () => {
    h.fcMap.mockRejectedValue(new Error('402 insufficient credits'));
    expect(errorOf(await webMap.handler({ url: PUBLIC }, ctx))).toBe('402 insufficient credits');
  });
});

describe('web_crawl', () => {
  const DOCS = [
    { markdown: '# A', metadata: { sourceURL: 'https://93.184.216.34/docs/a' } },
    { markdown: '# B', metadata: { url: 'https://93.184.216.34/docs/b?page=2' } },
    { markdown: '', metadata: { sourceURL: 'https://93.184.216.34/docs/empty' } },
    { markdown: '# C', metadata: { sourceURL: 'not a url' } },
  ];

  beforeEach(() => {
    vi.mocked(getApiKey).mockResolvedValue('fc-key');
  });

  it('refuses the team surface, a private target and a missing key before any crawl', async () => {
    expect(errorOf(await webCrawl.handler({ url: PUBLIC }, TEAM_CTX))).toMatch(/owner-side tool/);
    expect(errorOf(await webCrawl.handler({ url: METADATA }, ctx))).toMatch(
      /private\/internal address/,
    );
    vi.mocked(getApiKey).mockResolvedValue(null);
    expect(errorOf(await webCrawl.handler({ url: PUBLIC }, ctx))).toMatch(/no firecrawl API key/);
    expect(h.fcCtor).not.toHaveBeenCalled();
    expect(createDocCollection).not.toHaveBeenCalled();
  });

  it('forwards the page cap and path filters to Firecrawl', async () => {
    await webCrawl.handler(
      { url: PUBLIC, limit: 10, include_paths: ['^/docs/', 7], exclude_paths: ['/blog/'] },
      ctx,
    );
    expect(h.fcMap).not.toHaveBeenCalled();
    expect(h.fcCrawl).toHaveBeenCalledWith(
      PUBLIC,
      expect.objectContaining({
        limit: 10,
        scrapeOptions: { formats: ['markdown'] },
        includePaths: ['^/docs/'],
        excludePaths: ['/blog/'],
      }),
    );
  });

  it('says the crawl returned nothing rather than creating an empty collection', async () => {
    h.fcCrawl.mockResolvedValue({ status: 'completed', data: [] });
    const err = errorOf(await webCrawl.handler({ url: PUBLIC }, ctx));
    expect(err).toMatch(/returned no pages/);
    expect(err).toMatch(/web_map/);
    expect(createDocCollection).not.toHaveBeenCalled();
    expect(upsertDocFromDisk).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('scopes the per-site collection lookup to the caller', async () => {
    // Drop `eq(docCollections.ownerId, ...)` and a crawl of a host another
    // owner has already crawled would append its pages to THEIR collection.
    h.fcCrawl.mockResolvedValue({ status: 'completed', data: DOCS });
    h.selectQueue.push([]);
    await webCrawl.handler({ url: PUBLIC }, ctx);
    expect(paramsOf(h.selectWheres.at(-1))).toContain('o1');
  });

  it('creates the per-site collection DISABLED under the caller, then upserts each page', async () => {
    h.fcCrawl.mockResolvedValue({ status: 'completed', data: DOCS });
    h.selectQueue.push([]); // no existing collection for this host
    vi.mocked(upsertDocFromDisk)
      .mockResolvedValueOnce({ status: 'inserted' } as never)
      .mockResolvedValueOnce({ status: 'updated' } as never);

    const out = outputOf(await webCrawl.handler({ url: PUBLIC }, ctx));

    expect(createDocCollection).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        key: expect.stringMatching(/^crawl-/),
        rootPath: expect.stringMatching(/^crawl\//),
        brainDepth: 'retrieval',
        origin: 'crawl',
        enabled: false,
      }),
    );
    // Two real pages upserted, both scoped to the caller; the empty page and
    // the junk source url are skipped, not stored.
    expect(upsertDocFromDisk).toHaveBeenCalledTimes(2);
    expect(upsertDocFromDisk).toHaveBeenNthCalledWith(1, {
      ownerId: 'o1',
      collection: COLLECTION,
      relPath: 'docs/a.md',
      bytes: expect.any(Buffer),
    });
    const firstBody = vi.mocked(upsertDocFromDisk).mock.calls[0]![0].bytes.toString('utf8');
    expect(firstBody).toBe('> Source: https://93.184.216.34/docs/a\n\n# A\n');

    expect(out).toMatchObject({
      ok: true,
      url: PUBLIC,
      collection: 'crawl-93-184-216-34',
      status: 'completed',
      pages: { inserted: 1, updated: 1, unchanged: 0, skipped: 2 },
    });
    expect(out.samplePaths).toHaveLength(2);
    expect(out.samplePaths).toContain('docs/a.md');
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent_tool',
        ownerId: 'o1',
        payload: expect.objectContaining({ via: 'web_crawl_tool', collection: COLLECTION.key }),
      }),
    );
  });

  it('reuses an existing collection and counts an unchanged page as free', async () => {
    h.fcCrawl.mockResolvedValue({ status: 'completed', data: [DOCS[0]] });
    h.selectQueue.push([COLLECTION]);
    vi.mocked(upsertDocFromDisk).mockResolvedValue({ status: 'unchanged' } as never);
    const out = outputOf(await webCrawl.handler({ url: PUBLIC }, ctx));
    expect(createDocCollection).not.toHaveBeenCalled();
    expect(out.pages).toEqual({ inserted: 0, updated: 0, unchanged: 1, skipped: 0 });
  });

  it('reports a Firecrawl failure as a tool error and stores nothing', async () => {
    h.fcCrawl.mockRejectedValue(new Error('crawl timed out'));
    expect(errorOf(await webCrawl.handler({ url: PUBLIC }, ctx))).toBe('crawl timed out');
    expect(createDocCollection).not.toHaveBeenCalled();
    expect(upsertDocFromDisk).not.toHaveBeenCalled();
  });
});

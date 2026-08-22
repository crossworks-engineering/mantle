/**
 * Web crawl builtins — whole-site ingestion via the Firecrawl CLOUD API.
 *
 * Where `web_fetch` reads ONE page into the turn and `web_search` asks Sonar,
 * these two bring a SITE into the brain as durable, searchable documentation:
 *
 *   web_map   — cheap discovery: list a site's URLs, no content fetched.
 *   web_crawl — fetch up to `limit` pages as clean markdown and upsert each
 *               into a per-site `documentation` collection (origin 'crawl').
 *
 * The ingest path is the documentation one on purpose: `upsertDocFromDisk`
 * never touches the disk (it takes bytes), its sha256 gate makes re-crawls of
 * unchanged pages free, and documentation defaults to retrieval-only brain
 * depth — summary + embedding + chunks, no L4 facts/entities — so a 50-page
 * crawl cannot flood the personal graph or the LLM budget. The collection is
 * created DISABLED with a rootPath that never exists on disk, so the docs-sync
 * watcher ignores it and a stray reconcile finds an empty root (the empty-root
 * guard then deletes nothing).
 *
 * Costs REAL MONEY on the operator's Firecrawl plan (1 credit ≈ 1 page), so:
 * owner-only (tool group `crawl`, never the team responder — belt-and-braces
 * refusal below), schema-capped page limits, and no cron/trigger ever calls
 * this — a crawl is always an explicit ask (cost-safety house rule).
 */

import { and, eq } from 'drizzle-orm';
import { Firecrawl } from 'firecrawl';
import { apiKeys, db, docCollections, type DocCollection } from '@mantle/db';
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import { createDocCollection, slugifyFolder, upsertDocFromDisk } from '@mantle/files';
import { recordIngest, step } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { assertFetchableUrl } from './ssrf-guard';
import { str } from './coerce';

const KEY_HINT =
  'no firecrawl API key configured — add one at /settings/keys (service `firecrawl`; keys at https://www.firecrawl.dev). The free tier covers ~1,000 pages/month.';

/** A Firecrawl key for this owner — prefers the 'default' label, falls back to
 *  any firecrawl key on file (same shape as resolveOpenRouterKey). */
async function resolveFirecrawlKey(ownerId: string): Promise<string | null> {
  const k = await getApiKey(ownerId, 'firecrawl');
  if (k) return k;
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, ownerId), eq(apiKeys.service, 'firecrawl')))
    .limit(1);
  return row ? await getApiKeyById(row.id) : null;
}

/** Belt-and-braces on top of the tool-group grant: outbound fetches that spend
 *  the owner's crawl credits never run for a team surface. */
export function refuseTeamSurface(ctx: { surface?: { kind?: string } }): ToolHandlerResult | null {
  if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
    return { ok: false, error: 'owner-side tool — not available on the team surfaces' };
  }
  return null;
}

/** Parse + vet the target URL. Firecrawl's cloud does the fetching, so this is
 *  hygiene rather than SSRF defence: refuse non-http(s) schemes and hosts that
 *  don't resolve publicly (their crawler couldn't reach those anyway). */
async function vetUrl(raw: string): Promise<{ ok: true; url: URL } | ToolHandlerResult> {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'url is required — an http(s) address of the site to target' };
  let url: URL;
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return { ok: false, error: `'${s}' is not a valid URL — pass e.g. https://docs.example.com` };
  }
  try {
    await assertFetchableUrl(url.toString());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, url };
}

// ─── URL → collection-relative markdown path ───────────────────────
// Each path segment is slugified independently so the result is both a valid
// set of ltree labels and readable ('/SDKs/Node.JS' → 'sdks/node-js.md').
// Query strings are folded into the stem so ?page=2 doesn't collide with the
// bare page. Two URLs that slugify identically DO collide — last write wins,
// which is the right call for trailing-slash / case duplicates.
export function relPathForUrl(u: URL): string {
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => slugifyFolder(decodeURIComponent(s)) ?? 'x');
  let stem = segs.pop() ?? 'index';
  if (u.search) {
    const q = slugifyFolder(u.search);
    if (q) stem = `${stem}-${q}`.slice(0, 120);
  }
  return (segs.length ? `${segs.join('/')}/` : '') + `${stem}.md`;
}

/** The per-site collection: key `crawl-<host>`, DISABLED (the docs-sync
 *  watcher only touches enabled collections), rootPath under `crawl/` (never
 *  exists on disk, so an accidental enable+reconcile is a no-op). */
async function ensureCrawlCollection(ownerId: string, host: string): Promise<DocCollection> {
  const hostSlug = slugifyFolder(host) ?? 'site';
  const key = `crawl-${hostSlug}`;
  const [existing] = await db
    .select()
    .from(docCollections)
    .where(and(eq(docCollections.ownerId, ownerId), eq(docCollections.key, key)))
    .limit(1);
  if (existing) return existing;
  const { collection } = await createDocCollection(ownerId, {
    key,
    label: `Crawl: ${host}`,
    rootPath: `crawl/${hostSlug}`,
    brainDepth: 'retrieval',
    origin: 'crawl',
    enabled: false,
  });
  return collection;
}

/** Loose view over a Firecrawl crawl result document. */
type CrawledDoc = {
  markdown?: unknown;
  metadata?: { sourceURL?: unknown; url?: unknown; title?: unknown };
};

// ─── web_map ───────────────────────────────────────────────────────

const web_map: BuiltinToolDef = {
  slug: 'web_map',
  name: 'Map a website',
  description:
    "List a website's URLs (sitemap-style discovery) WITHOUT fetching page content. Returns `links` found on the site at `url`, optionally filtered by `search`. Use it to scope a site before `web_crawl` — find how big it is and which subpath holds the content you want. For reading one page into the turn use `web_fetch`; for a synthesised answer use `web_search`. Needs a `firecrawl` API key (/settings/keys) and spends a small amount of Firecrawl credit per call.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Site or subpath to map, e.g. https://docs.example.com' },
      search: {
        type: 'string',
        description: "Optional keyword filter for the returned links, e.g. 'pricing'.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Max links to return.',
      },
    },
    required: ['url'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const vetted = await vetUrl(str(input.url));
    if (!('url' in vetted)) return vetted;
    const apiKey = await resolveFirecrawlKey(ctx.ownerId);
    if (!apiKey) return { ok: false, error: KEY_HINT };
    const limit = typeof input.limit === 'number' ? input.limit : 100;
    const search = str(input.search).trim() || undefined;

    try {
      const links = await step(
        { name: 'web_map', kind: 'http', input: { url: vetted.url.toString(), limit } },
        async (h) => {
          const client = new Firecrawl({ apiKey });
          const res = (await client.map(vetted.url.toString(), {
            limit,
            ...(search ? { search } : {}),
          } as Parameters<Firecrawl['map']>[1])) as unknown as {
            links?: Array<string | { url?: string; title?: string }>;
          };
          const out = (res.links ?? [])
            .map((l) => (typeof l === 'string' ? { url: l } : { url: l.url ?? '', title: l.title }))
            .filter((l) => l.url);
          h.setMeta({ links: out.length });
          return out;
        },
      );
      return { ok: true, output: { url: vetted.url.toString(), count: links.length, links } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── web_crawl ─────────────────────────────────────────────────────

const web_crawl: BuiltinToolDef = {
  slug: 'web_crawl',
  name: 'Crawl a website into the brain',
  description:
    'Crawl a website and store its pages as searchable documentation. Fetches up to `limit` pages under `url` as clean markdown (JS-rendered, via the Firecrawl cloud) and upserts each into a per-site documentation collection; on a re-crawl, unchanged pages are skipped free. Returns the collection key plus inserted/updated/skipped counts. **Spends Firecrawl credits — roughly one per page — so start small and scope tightly**: run `web_map` first, crawl the deepest `url` that covers the need, and use `include_paths`. For one page use `web_fetch`. Long-running — up to minutes. Needs a `firecrawl` API key (/settings/keys).',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Start URL; the crawl stays under it, so deeper = cheaper (https://example.com/docs beats https://example.com).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 25,
        description: 'Max pages to fetch (each costs a credit).',
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: "Only crawl URLs whose path matches one of these regexes, e.g. ['^/docs/'].",
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: "Skip URLs whose path matches one of these regexes, e.g. ['/blog/.*'].",
      },
    },
    required: ['url'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const refused = refuseTeamSurface(ctx);
    if (refused) return refused;
    const vetted = await vetUrl(str(input.url));
    if (!('url' in vetted)) return vetted;
    const apiKey = await resolveFirecrawlKey(ctx.ownerId);
    if (!apiKey) return { ok: false, error: KEY_HINT };
    const limit = typeof input.limit === 'number' ? input.limit : 25;
    const includePaths = Array.isArray(input.include_paths)
      ? input.include_paths.filter((p): p is string => typeof p === 'string')
      : undefined;
    const excludePaths = Array.isArray(input.exclude_paths)
      ? input.exclude_paths.filter((p): p is string => typeof p === 'string')
      : undefined;

    let docs: CrawledDoc[];
    let crawlStatus: string;
    try {
      const job = await step(
        { name: 'web_crawl', kind: 'http', input: { url: vetted.url.toString(), limit } },
        async (h) => {
          const client = new Firecrawl({ apiKey });
          const res = (await client.crawl(vetted.url.toString(), {
            limit,
            scrapeOptions: { formats: ['markdown'] },
            ...(includePaths?.length ? { includePaths } : {}),
            ...(excludePaths?.length ? { excludePaths } : {}),
            // Waiter tuning: poll gently, give up after 15 min wall-clock
            // rather than holding the turn forever on a stuck job.
            pollInterval: 3,
            timeout: 900,
          } as Parameters<Firecrawl['crawl']>[1])) as unknown as {
            status?: string;
            data?: CrawledDoc[];
          };
          h.setMeta({ status: res.status, pages: res.data?.length ?? 0 });
          return res;
        },
      );
      docs = job.data ?? [];
      crawlStatus = typeof job.status === 'string' ? job.status : 'unknown';
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (docs.length === 0) {
      return {
        ok: false,
        error: `crawl finished (status: ${crawlStatus}) but returned no pages — the site may block crawlers or the start url/include_paths matched nothing. Try web_map to see what is reachable.`,
      };
    }

    const collection = await ensureCrawlCollection(ctx.ownerId, vetted.url.host);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const samplePaths: string[] = [];
    for (const doc of docs) {
      const md = typeof doc.markdown === 'string' ? doc.markdown.trim() : '';
      const srcRaw = doc.metadata?.sourceURL ?? doc.metadata?.url;
      const src = typeof srcRaw === 'string' ? srcRaw : null;
      if (!md || !src) {
        skipped++;
        continue;
      }
      let pageUrl: URL;
      try {
        pageUrl = new URL(src);
      } catch {
        skipped++;
        continue;
      }
      const relPath = relPathForUrl(pageUrl);
      // The source line is part of the hashed content — stable across
      // re-crawls (no dates), so the sha gate still no-ops unchanged pages.
      const body = `> Source: ${pageUrl.toString()}\n\n${md}\n`;
      const res = await upsertDocFromDisk({
        ownerId: ctx.ownerId,
        collection,
        relPath,
        bytes: Buffer.from(body, 'utf8'),
      });
      if (res.status === 'inserted') inserted++;
      else if (res.status === 'updated') updated++;
      else unchanged++;
      if (samplePaths.length < 10) samplePaths.push(relPath);
    }

    void recordIngest({
      source: 'agent_tool',
      ownerId: ctx.ownerId,
      summary: `Site crawled: ${vetted.url.host} (${inserted + updated + unchanged} pages)`,
      payload: {
        via: 'web_crawl_tool',
        url: vetted.url.toString(),
        collection: collection.key,
        inserted,
        updated,
        unchanged,
        skipped,
      },
    });

    return {
      ok: true,
      output: {
        ok: true,
        url: vetted.url.toString(),
        collection: collection.key,
        status: crawlStatus,
        pages: { inserted, updated, unchanged, skipped },
        samplePaths,
        note: 'Pages are indexed as documentation (retrieval depth) — find them with search_chunks / search_nodes.',
      },
    };
  },
};

export const CRAWL_TOOLS: readonly BuiltinToolDef[] = [web_map, web_crawl];

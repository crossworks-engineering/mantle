# Web crawl — whole-site ingestion via Firecrawl

Two owner-only tools (`crawl` tool group) turn a website into searchable
documentation in the brain, backed by the **Firecrawl cloud API**
(https://www.firecrawl.dev — the AGPL self-host stack is deliberately NOT
bundled; the MIT `firecrawl` npm SDK talks to their hosted service).

| tool        | what it does                                                | cost                 |
| ----------- | ----------------------------------------------------------- | -------------------- |
| `web_map`   | list a site's URLs, no content fetched                      | ~free (small credit) |
| `web_crawl` | fetch up to `limit` pages as markdown → documentation nodes | ~1 credit / page     |

## Setup

Add a key with service **`firecrawl`** at `/settings/keys` (use the custom
service field). Free tier: ~1,000 pages/month. No key → the tools return a
teaching error pointing here. Note: the "test key" probe only knows LLM
adapters, so a saved Firecrawl key reports "can't test this" — that is
cosmetic, the tools will still use it.

## Where crawled pages land

Each site gets a `doc_collections` row: key `crawl-<host>`, `origin: 'crawl'`,
**disabled** (the disk-sync watcher only touches enabled collections), with a
`rootPath` under `crawl/` that never exists on disk — so an accidental
enable/reconcile hits the empty-root guard and deletes nothing. ⚠ Toggling the
collection on and back off in /settings/documentation purges its nodes (that is
what disable means); re-crawling restores them.

Pages are `type='documentation'` nodes at **retrieval** brain depth: summary +
embedding + heading chunks (local models, near-zero spend), no L4
facts/entities. Identity is `(collection, rel_path)` where `rel_path` is the
slugified URL path; the body carries a `> Source: <url>` first line. The
sha256 gate makes re-crawls of unchanged pages free. Pages removed from the
site are NOT deleted on re-crawl (v1 is upsert-only).

## Cost safety

- Schema-capped: `web_crawl` limit ≤ 200/call (default 25), `web_map` ≤ 500.
- Owner-only; refused on team/forum surfaces (belt-and-braces in the handler).
- Never wire these to a cron, trigger, or maintenance task — a crawl is always
  an explicit ask (house cost-safety rule).
- Scope crawls: `web_map` first, start from the deepest URL that covers the
  need, use `include_paths` regexes.

## Code map

- Tools: `packages/tools/src/builtins-crawl.ts` (group in the system manifest).
- Ingest reuse: `upsertDocFromDisk` (`packages/files/src/docs.ts`) — despite
  the name it never reads the disk; it takes bytes.
- SDK: `firecrawl` npm (v4), `client.map` / `client.crawl` waiter with a 15 min
  wall-clock timeout.

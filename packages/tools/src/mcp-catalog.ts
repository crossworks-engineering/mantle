/**
 * Catalog of pre-known external MCP servers — the `KNOWN_KEY_SERVICES` twin
 * for MCP connectors. Server-driven on purpose: the connectors API returns it
 * so the settings UI can render a placeholder row per entry ("not connected —
 * add") without the user knowing a slug, and a new entry reaches the client
 * without a contract-package release.
 *
 * `whenToUse` is the load-bearing field: it becomes part of the generated
 * connector group description, which is WHERE the "call this vs the built-in
 * tools" judgment lives (the prose rung — no routing machinery). Keep it one
 * or two sentences and name the built-in alternative when one exists.
 *
 * Deliberately NOT auto-provisioned: where first-party builtins overlap
 * (Firecrawl: web_map/web_crawl own the crawl-and-ingest path), the entry
 * documents the boundary instead of standing up the connector.
 */

export type KnownMcpServer = {
  /** Connector slug — the group becomes `mcp-<slug>`. */
  slug: string;
  /** Display name for the placeholder row. */
  label: string;
  /** One sentence: what connecting this server adds. */
  description: string;
  /** The server's streamable-HTTP endpoint (key-authed shape). */
  url: string;
  /** `api_keys.service` the credential is stored under, when key-authed. */
  secretService?: string;
  /** Where the user gets a key / reads about the server. */
  docsUrl: string;
  /** Selection guidance folded into the generated group description. */
  whenToUse: string;
};

export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = [
  {
    slug: 'firecrawl',
    label: 'Firecrawl MCP',
    description:
      'Firecrawl’s hosted MCP server: ad-hoc web scrape, search, and structured extract straight into the conversation.',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    secretService: 'firecrawl',
    docsUrl: 'https://docs.firecrawl.dev/mcp-server',
    whenToUse:
      'Use for one-off scrape/search/extract where the page content should land IN the conversation. For crawling a site into durable, searchable brain documentation use the built-in `web_map` / `web_crawl` tools instead — they own the ingest path and return counts, not content.',
  },
];

export function knownMcpServer(slug: string): KnownMcpServer | undefined {
  return KNOWN_MCP_SERVERS.find((s) => s.slug === slug);
}

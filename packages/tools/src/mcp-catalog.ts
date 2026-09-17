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
  /** The server's OAuth endpoint, when it also offers the MCP OAuth flow. */
  oauthUrl?: string;
  /** `api_keys.service` the credential is stored under, when key-authed. */
  secretService?: string;
  /** Where the user gets a key / reads about the server. */
  docsUrl: string;
  /** Selection guidance folded into the generated group description. */
  whenToUse: string;
  /** The server's sign-in needs a pre-registered app, because its
   *  authorization server offers no dynamic registration. 'microsoft': the
   *  Settings → Microsoft app works (Entra ID fronts the server). */
  oauthClient?: 'microsoft';
  /** Steps outside Mantle that the owner, or their IT admin, must do first. */
  setup?: string[];
};

export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = [
  {
    slug: 'firecrawl',
    label: 'Firecrawl MCP',
    description:
      'Firecrawl’s hosted MCP server: ad-hoc web scrape, search, and structured extract straight into the conversation.',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    oauthUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    secretService: 'firecrawl',
    docsUrl: 'https://docs.firecrawl.dev/mcp-server',
    whenToUse:
      'Use for one-off scrape/search/extract where the page content should land IN the conversation. For crawling a site into durable, searchable brain documentation use the built-in `web_map` / `web_crawl` tools instead — they own the ingest path and return counts, not content.',
  },
  {
    slug: 'deepwiki',
    label: 'DeepWiki MCP',
    description:
      'DeepWiki’s free hosted MCP server: ask questions about any public GitHub repository and read its AI-generated docs. No key needed.',
    url: 'https://mcp.deepwiki.com/mcp',
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    whenToUse:
      'Use to understand a public GitHub repository — its structure, docs, or how something in it works. For general web questions use the researcher’s `web_search`/`web_fetch` instead; for THIS product’s own code the brain’s indexed docs win.',
  },
  {
    slug: 'powerbi',
    label: 'Power BI (Microsoft)',
    description:
      'Microsoft’s remote Power BI MCP server (preview): ask questions of Power BI semantic models. It reads a model’s schema and runs DAX as the signed-in user, so row-level security applies.',
    url: 'https://api.fabric.microsoft.com/v1/mcp/powerbi',
    oauthUrl: 'https://api.fabric.microsoft.com/v1/mcp/powerbi',
    oauthClient: 'microsoft',
    docsUrl:
      'https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-external-clients',
    whenToUse:
      'Use to answer questions from the organisation’s Power BI semantic models (measures, KPIs, report data). Needs the semantic model id, from the model’s URL in app.powerbi.com. Read the schema, then write the DAX yourself: its Generate Query tool spends Copilot capacity. For documents and SharePoint files use the brain’s own search instead.',
    setup: [
      'A Power BI admin turns on the tenant setting "Users can use the Power BI Model Context Protocol server endpoint (preview)".',
      'Settings → Microsoft has an Azure app. On that app in Azure: API permissions → Power BI Service → delegated Dataset.Read.All, MLModel.Execute.All and Workspace.Read.All, then Grant admin consent.',
      'On the same app: Authentication → add this box’s connector callback URL under the Web platform. Not “Mobile and desktop”, as Microsoft’s guide says for desktop apps: Mantle sends the app’s secret, and Entra refuses a secret on a public-client redirect.',
      'Each user needs Build permission on the semantic models they query.',
    ],
  },
];

export function knownMcpServer(slug: string): KnownMcpServer | undefined {
  return KNOWN_MCP_SERVERS.find((s) => s.slug === slug);
}

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The service binding that turns a plain capability bundle into an API
 * *integration*: where its calls go, which vault entry authenticates them,
 * where the credential is placed, and which file node holds the stored API
 * documentation. Set by Toolsmith at group-setup time (or by the owner in
 * Settings → Tool groups); NULL on every manifest/capability-only group.
 *
 * `secretRef` is a `service/label` pointer into `api_keys` and `authTemplate`
 * carries the same `{{secret:service/label}}` strings http tool templates
 * already use — a plaintext secret never lands here. Validation +
 * accessors live in @mantle/tools (`integration.ts`).
 */
/**
 * The binding that makes a group an MCP CONNECTOR: the streamable-HTTP endpoint
 * of an external MCP server whose tools are mirrored into this group as
 * `handler.kind === 'mcp'` rows by the connector sync. The connector and the
 * group are strictly 1:1 — no separate connectors table (same reasoning as the
 * API-integration binding above it).
 *
 * `secretRef` is a `service/label` pointer into `api_keys`, resolved only at
 * connect time; a plaintext credential never lands here. The sync-bookkeeping
 * fields (`lastSyncAt`, `toolCount`, `serverInfo`) are written by the sync,
 * not by hand.
 */
/**
 * OAuth 2.1 client state for a connector whose server requires the MCP auth
 * flow (discovery → dynamic registration → PKCE authorization code → refresh).
 * Only NON-SECRET bookkeeping lives here; the client registration, tokens, and
 * PKCE verifier are sealed in the api_keys vault under the connector's group
 * slug (labels `oauth-client` / `oauth-tokens` / `oauth-verifier`).
 */
export type ToolGroupMcpOAuth = {
  enabled: true;
  /** 'pending' until the first authorization completes; 'needs_reconnect'
   *  when a refresh died and the owner must re-authorize. */
  status: 'pending' | 'connected' | 'needs_reconnect';
  /** client_id from dynamic registration (public identifier, not a secret). */
  clientId?: string;
  /** Set while an authorization redirect is in flight. */
  pending?: { state: string; redirectUri: string; startedAt: string };
  /** The redirect_uri of the last completed authorization — the runtime
   *  refresh path must present a redirect-capable client to the SDK, or the
   *  flow is misread as non-interactive and refresh never runs. */
  redirectUri?: string;
  tokenExpiresAt?: string;
  connectedAt?: string;
  lastError?: string;
};

export type ToolGroupMcpBinding = {
  /** Streamable-HTTP endpoint, e.g. 'https://mcp.firecrawl.dev/v2/mcp'. */
  url: string;
  /** `service/label` pointer into the api_keys vault — never a plaintext. */
  secretRef?: string;
  /** Set when the server authenticates via the MCP OAuth flow instead of a
   *  static key; `secretRef`/`authHeader` are ignored while enabled. */
  oauth?: ToolGroupMcpOAuth;
  /** Header the credential is sent in. Default 'Authorization'. */
  authHeader?: string;
  /** Prefix before the credential in the header value. Default 'Bearer '.
   *  An empty string sends the credential bare. */
  authScheme?: string;
  /** Set by the connector sync. */
  lastSyncAt?: string;
  toolCount?: number;
  serverInfo?: { name?: string; version?: string };
};

/**
 * The binding that makes a group an OPENAPI CONNECTOR: a service's
 * OpenAPI/Swagger spec URL whose operations are compiled into ordinary
 * `handler.kind === 'http'` rows (provenance on `handler.openapi`) by the
 * connector sync. Composes with the surrounding integration fields: the
 * group's `baseUrl`/`secretRef`/`authTemplate` feed the same authoring-time
 * inheritance hand-authored http tools use, so auth never comes from the
 * spec. The sync-bookkeeping fields are written by the sync, not by hand.
 */
export type ToolGroupOpenapiBinding = {
  /** Where the spec is fetched from, e.g. 'https://example.com/openapi.json'. */
  specUrl: string;
  /** sha256 of the raw fetched spec bytes — change visibility, not identity. */
  specHash?: string;
  /**
   * Which operations materialise as tools. `tags` includes every operation
   * carrying one of these spec tags; `operations` names identities
   * (operationId, or 'get /path' for id-less operations). Effective set =
   * union of both; absent means ALL, which is only legal under the hard cap.
   */
  selection?: { tags?: string[]; operations?: string[] };
  apiTitle?: string;
  apiVersion?: string;
  /** Set by the connector sync. */
  lastSyncAt?: string;
  toolCount?: number;
};

export type ToolGroupIntegration = {
  /** Vendor/service key, e.g. 'openweathermap'. */
  service: string;
  /** Base URL relative tool paths are joined onto, e.g. 'https://api.example.com/v1'. */
  baseUrl?: string;
  /** `service/label` pointer into the api_keys vault — never a plaintext. */
  secretRef?: string;
  /** Header/query fragment merged UNDER each authored tool's own maps. */
  authTemplate?: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
  /** `nodes` id of the markdown file holding this API's stored documentation. */
  docsNodeId?: string;
  /**
   * Slug of the `skills` row carrying this integration's USAGE know-how — which
   * endpoint answers which question, unit conventions, how to chain calls.
   * Convention: `api-<group-slug>`. It travels WITH the grant: an agent granted
   * this group gets the skill in its context (see the effective-skills union in
   * @mantle/agent-runtime), which is why it must stay short. The docs file
   * remains the reference; the skill is judgment.
   */
  skillSlug?: string;
  /** Where the stored docs came from (URL) + when they were captured. */
  docsSourceUrl?: string;
  docsUpdatedAt?: string;
  /** Set when this group is an MCP connector; absent on every other group. */
  mcp?: ToolGroupMcpBinding;
  /** Set when this group is an OpenAPI connector; absent on every other group. */
  openapi?: ToolGroupOpenapiBinding;
};

/**
 * A named bundle of tools an owner grants to an agent as a unit (e.g. "Pages
 * toolkit", "Calendar", "Memory core"). Capability-only in the sense that
 * matters: no instructions, no behaviour — that's what `skills` are for. See
 * docs/tools-and-skills.md. A group MAY additionally carry static integration
 * *configuration* (`integration`) — a base URL, a vault ref, an auth
 * placement, a docs pointer — which is data the authoring path reads, not
 * behaviour handed to a model.
 *
 * Phase 0 (dormant substrate): the table + `agents.tool_group_slugs` exist and
 * are seeded from the manifest, but the runtime does not yet expand groups into
 * an agent's effective tool set — that's Phase 1's `effectiveToolSlugs` flip.
 */
export const toolGroups = pgTable(
  'tool_groups',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    /** Tool slugs this group confers when granted to an agent. */
    toolSlugs: text('tool_slugs')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    /** Service binding when this group IS an API integration; NULL otherwise. */
    integration: jsonb('integration').$type<ToolGroupIntegration>(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('tool_groups_owner_slug_uq').on(t.ownerId, t.slug),
    index('tool_groups_owner_idx').on(t.ownerId),
  ],
);

export type ToolGroup = typeof toolGroups.$inferSelect;
export type NewToolGroup = typeof toolGroups.$inferInsert;

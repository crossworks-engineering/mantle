/**
 * @mantle/client-types · agent-graph
 *
 * Skills, tools, tool groups and AI workers — the pieces an agent is
 * assembled from.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Skills ────────────────────────────────────────────────────────────────────

/** A skill as returned by `GET /api/skills`. */
export interface SkillDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  /** Template state heartbeats inherit on create. */
  defaultState: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A heartbeat that references a skill — drives the "used by N heartbeats" badge. */
export interface HeartbeatRef {
  slug: string;
  name: string;
  status: string;
}

/** `GET /api/skills/backrefs` — heartbeat refs keyed by skill slug. */
export type SkillBackrefs = Record<string, HeartbeatRef[]>;

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Tool handler descriptor — the canonical wire shape. Mirrors @mantle/db's
 * `ToolHandler` union; kept standalone here so this package stays zero-dep (no
 * postgres type graph). Drift is caught where it matters: `@mantle/tools` aliases
 * `ToolSummary = ToolDTO`, so if db's union ever diverges from this one, that
 * package fails to compile.
 */
export interface RecipeStep {
  tool: string;
  input?: Record<string, unknown>;
  as?: string;
}

export type ToolHandler =
  | { kind: 'builtin'; ref: string }
  | {
      kind: 'http';
      url: string;
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string | null;
      headersRef?: string | null;
      authRef?: string | null;
      timeoutMs?: number;
      /** Provenance on rows materialised by an OpenAPI connector's sync. */
      openapi?: { group: string; op: string; vanishedAt?: string; editedAt?: string };
    }
  | { kind: 'shell'; cmd: string }
  | { kind: 'mcp'; group: string; toolName: string; vanishedAt?: string }
  | { kind: 'recipe'; steps: RecipeStep[]; output?: unknown };

/** A tool as returned by `GET /api/tools`. */
export interface ToolDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET/PUT /api/tools/settings` — the two owner-level tool policy toggles. */
export interface ToolSettings {
  /** Tools an agent authors (Toolsmith) start confirm-gated until cleared. */
  requireApproval: boolean;
  /** Unattended heartbeats park email/web calls for approval. */
  egressGate: boolean;
}

// ── Tool groups ───────────────────────────────────────────────────────────────

/**
 * The service binding on a group that IS an API integration: where its calls go,
 * which vault entry authenticates them, where that credential is placed, and
 * pointers to the stored API docs + usage skill. Mirrors the `ToolGroupIntegration`
 * type in @mantle/db. `secretRef` is a `service/label` pointer and auth-template
 * values are `{{secret:…}}` refs — a plaintext key never crosses this wire.
 */
export interface ToolGroupIntegrationDTO {
  service: string;
  baseUrl?: string;
  secretRef?: string;
  authTemplate?: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
  };
  docsNodeId?: string;
  docsSourceUrl?: string;
  docsUpdatedAt?: string;
  /** Slug of the usage skill that travels with this group's grant. */
  skillSlug?: string;
  /** Set when the group is an MCP CONNECTOR — a mirror of an external MCP
   *  server's tools. `secretRef` is a `service/label` vault pointer; the
   *  sync-bookkeeping fields are written by the connector sync. */
  mcp?: {
    url: string;
    secretRef?: string;
    authHeader?: string;
    authScheme?: string;
    /** OAuth bookkeeping when the server uses the MCP auth flow. Tokens and
     *  the client registration are vault-sealed and never cross this wire. */
    oauth?: {
      enabled: true;
      status: 'pending' | 'connected' | 'needs_reconnect';
      clientId?: string;
      pending?: { state: string; redirectUri: string; startedAt: string };
      redirectUri?: string;
      tokenExpiresAt?: string;
      connectedAt?: string;
      lastError?: string;
    };
    lastSyncAt?: string;
    toolCount?: number;
    serverInfo?: { name?: string; version?: string };
  };
  /** Set when the group is an OPENAPI CONNECTOR — its operations are compiled
   *  into ordinary http tools by the connector sync. Auth stays on the
   *  surrounding integration fields (`baseUrl`/`secretRef`/`authTemplate`),
   *  never in this block; the sync-bookkeeping fields are written by the sync. */
  openapi?: {
    specUrl: string;
    specHash?: string;
    selection?: { tags?: string[]; operations?: string[] };
    apiTitle?: string;
    apiVersion?: string;
    lastSyncAt?: string;
    toolCount?: number;
  };
}

/** A tool group — a named bundle of tool slugs granted to agents wholesale. */
export interface ToolGroupDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  toolSlugs: string[];
  /** Set when the group is an API integration; null for capability-only bundles. */
  integration: ToolGroupIntegrationDTO | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/tool-groups` — each group plus which agent slugs grant it. */
export interface ToolGroupWithRefs extends ToolGroupDTO {
  grantedTo: string[];
}

// ── AI workers ────────────────────────────────────────────────────────────────

/** Worker kinds (mirrors the @mantle/db `ai_worker_kind` enum). Pinned against
 *  the column at compile time by server/web/lib/client-types-drift.test.ts.
 *  `toAiWorkerDTO` in lib/ai-workers also catches drift while its mapping
 *  stays exhaustive, but that is a side effect rather than a guarantee. */
export type AiWorkerKind =
  | 'reflector'
  | 'extractor'
  | 'summarizer'
  | 'tts'
  | 'stt'
  | 'vision'
  | 'document'
  | 'image_gen'
  | 'embedding'
  | 'search'
  | 'search_advanced'
  | 'narrator'
  | 'suggester';

/** An AI worker as returned by `GET /api/ai-workers`. `params` is jsonb (shape
 *  varies by kind) — kept loose here; the form narrows per kind. */
export interface AiWorkerDTO {
  id: string;
  slug: string;
  name: string;
  kind: AiWorkerKind;
  provider: string;
  model: string;
  apiKeyId: string | null;
  systemPrompt: string | null;
  params: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  isDefault: boolean;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
  baseUrl: string | null;
  viaTailnet: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/ai-workers/config` — static-ish bits the worker form needs. */
export interface AiWorkerConfig {
  /** Providers with a native-PDF document adapter (vs. rasterize-at-ingest). */
  nativeDocProviders: string[];
  /** Online tailnet peer MagicDNS names (route base-URL datalist). */
  tailnetPeers: string[];
}

/**
 * @mantle/client-types — wire-shape (JSON) types for the HTTP API, shared by the
 * client components that consume `/api/**` (TanStack Query) and the server code
 * that produces the responses.
 *
 * Pure types: ZERO runtime, ZERO dependencies. That's the whole point — a client
 * component can name a row shape without importing `@mantle/db` (which drags
 * `postgres` into the browser bundle). This is the single source of truth for the
 * frontend/backend contract as screens move to client data-fetching (Phase 2 ·
 * Task 4); the server aliases its summary types to these so drift is a type error.
 *
 * Dates are ISO strings here — that's how they cross the wire (JSON has no Date).
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
    }
  | { kind: 'shell'; cmd: string };

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

/** A tool group — a named bundle of tool slugs granted to agents wholesale. */
export interface ToolGroupDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  toolSlugs: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/tool-groups` — each group plus which agent slugs grant it. */
export interface ToolGroupWithRefs extends ToolGroupDTO {
  grantedTo: string[];
}

// ── AI workers ────────────────────────────────────────────────────────────────

/** Worker kinds (mirrors the @mantle/db `ai_worker_kind` enum). Drift is caught
 *  by `toAiWorkerDTO` in lib/ai-workers, whose mapping won't compile if the db
 *  enum gains/renames a value. */
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
  | 'search_advanced';

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

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

// ── Agents ────────────────────────────────────────────────────────────────────

/** Conversational + worker roles an agent row can carry. Mirrors the
 *  `agent_role` enum (`packages/db/src/schema/agents.ts`); the `/settings/agents`
 *  page only lists the conversational ones. */
export type AgentRole =
  | 'assistant'
  | 'responder'
  | 'extractor'
  | 'summarizer'
  | 'reflector'
  | 'custom';

/** Per-agent generated avatar (style + seed → DiceBear). null = initials. */
export interface AgentAvatarDTO {
  style: string;
  seed: string;
}

/** Memory/budget tuning (jsonb). All fields optional — empty = runtime defaults.
 *  Replicated standalone (NOT re-exported from @mantle/db) to keep this package
 *  zero-dep; the server aliases its `AgentMemoryConfig` against this so drift is
 *  a compile error. */
export interface AgentMemoryConfigDTO {
  history_limit?: number;
  history_window_hours?: number | null;
  digest_limit?: number;
  fact_limit?: number;
  content_hit_limit?: number;
  chunk_limit?: number;
  inject_lifelog?: boolean;
  summarize_threshold?: number;
  summarize_batch?: number;
  extract_types?: string[];
  extract_facts?: boolean;
  extract_cost_cap_micro_usd?: number | null;
  delegate_to?: string[];
  max_iterations?: number;
  result_handling?: {
    inline_max_kb?: number;
    embed_min_kb?: number;
    spill_max_kb?: number;
  };
}

/** Sampling + voice-reply params (jsonb). */
export interface AgentParamsDTO {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  max_retries?: number;
  voice?: {
    enabled?: boolean;
    name?: 'alloy' | 'echo' | 'fable' | 'nova' | 'onyx' | 'shimmer';
    model?: 'tts-1' | 'tts-1-hd';
    speed?: number;
  };
}

/** One persona note (jsonb element). Soft-retired, never deleted — the read
 *  path filters `retiredAt`. `at`/`retiredAt` are ISO strings. */
export interface PersonaNoteDTO {
  id?: string;
  kind: 'style' | 'relationship' | 'correction';
  content: string;
  at: string;
  source?: { type: 'turn' | 'digest'; id: string };
  retiredAt?: string;
  retiredReason?: 'superseded' | 'removed';
  supersededBy?: string;
}

/** An agent as returned by `GET /api/agents` (and `…/[id]`). Dates are ISO
 *  strings. The server aliases its `AgentSummary` to this so the wire shape and
 *  the consuming client can't drift. */
export interface AgentDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: AgentRole;
  provider: string;
  model: string;
  apiKeyId: string | null;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  backupEnabled: boolean;
  baseUrl: string | null;
  viaTailnet: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
  ttsWorkerId: string | null;
  systemPrompt: string;
  skillSlugs: string[];
  toolGroupSlugs: string[];
  memoryConfig: AgentMemoryConfigDTO;
  params: AgentParamsDTO;
  avatar: AgentAvatarDTO | null;
  personaNotes: PersonaNoteDTO[];
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A lightweight agent option (slug + name + role) for picker dropdowns —
 *  `GET /api/agents/options`. Unlike `GET /api/agents` (conversational roles
 *  only), this lists EVERY agent, so heartbeats can bind worker-role agents. */
export interface AgentOptionDTO {
  slug: string;
  name: string;
  role: AgentRole;
}

// ── Calendar ────────────────────────────────────────────────────────────────────

/** A subscribed calendar feed as returned by `GET /api/calendar` — the wire
 *  projection of @mantle/db's `CalendarAccount` row. The sealed `feedUrlEnc`
 *  credential, `ownerId`, and `syncState` are server-only and intentionally
 *  omitted; dates are ISO strings. The route maps its rows to this so the wire
 *  shape and the consuming client can't drift. */
export interface CalendarAccountDTO {
  id: string;
  /** 'ics' (future: 'google' | 'microsoft'). */
  provider: string;
  displayName: string;
  /** Optional UI accent (hex) so multiple calendars are distinguishable. */
  color: string | null;
  enabled: boolean;
  lastEventCount: number | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// ── Microsoft (SharePoint / OneDrive) ───────────────────────────────────────────

/** A discovered drive as returned by `GET/POST /api/microsoft/accounts/[id]/drives`
 *  — the wire projection of @mantle/db's `MsDrive` row. The Graph `deltaLink`
 *  cursor and `accountId` are server-only and omitted; `lastSyncAt` is an ISO
 *  string. The route maps its rows to this so the shapes can't drift. */
export interface MsDriveDTO {
  id: string;
  /** Graph drive id. */
  driveId: string;
  /** `personal` (OneDrive) | `documentLibrary` (SharePoint) | other. */
  driveType: string;
  name: string;
  /** SharePoint site display name; null for OneDrive. */
  siteName: string | null;
  webUrl: string | null;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

// ── Email (inbox reading pane) ──────────────────────────────────────────────────

/** One message as returned by `GET /api/email/messages/[id]` — the wire
 *  projection of @mantle/db's `Email` row, trimmed to what the reading pane
 *  renders. Server-only/sensitive columns are dropped: the raw `bodyHtml` (it's
 *  sanitized server-side into `MessageDetailDTO.bodyHtmlSafe` and must never
 *  cross the wire untrusted), plus account/node/provider ids, labels, snippet,
 *  etc. `internalDate` is an ISO string. */
export interface EmailDTO {
  id: string;
  subject: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddrs: string[];
  ccAddrs: string[];
  internalDate: string;
  folder: string | null;
  isRead: boolean;
  isStarred: boolean;
  bodyText: string | null;
}

/** One attachment row returned with a message. */
export interface EmailAttachmentDTO {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** `GET /api/email/messages/[id]` — a message, its attachments, and the
 *  server-sanitized HTML body (the raw `bodyHtml` never crosses the wire). */
export interface MessageDetailDTO {
  email: EmailDTO;
  attachments: EmailAttachmentDTO[];
  bodyHtmlSafe: string | null;
}

// ── Heartbeats ─────────────────────────────────────────────────────────────────

/** A heartbeat's schedule (jsonb). `cron` is read-only in v1 (the form locks it);
 *  create/update only accept once/interval/manual. `at` is an ISO string. */
export type HeartbeatScheduleSpecDTO =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; every_minutes: number; jitter_minutes?: number }
  | { kind: 'cron'; expr: string }
  | { kind: 'manual' };

/** Where a heartbeat's reply is delivered (jsonb). */
export type HeartbeatSurfaceDTO =
  | { kind: 'telegram'; chat_id: string }
  | { kind: 'web' };

/** Optional quiet-hours window (jsonb). null tz = use the profile timezone. */
export interface HeartbeatQuietHoursDTO {
  from: string;
  to: string;
  tz?: string | null;
}

/** A heartbeat as returned by `GET /api/heartbeats(/[id])`. Dates are ISO
 *  strings. The server aliases its `HeartbeatSummary` to this so the wire shape
 *  and the consuming client can't drift. */
export interface HeartbeatDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  agentSlug: string;
  skillSlug: string;
  scheduleKind: 'once' | 'interval' | 'cron' | 'manual';
  schedule: HeartbeatScheduleSpecDTO;
  surface: HeartbeatSurfaceDTO;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  fireCount: number;
  maxFires: number | null;
  minIdleMinutes: number | null;
  quietHours: HeartbeatQuietHoursDTO | null;
  earliestAt: string | null;
  cooldownMinutes: number | null;
  state: Record<string, unknown>;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  completionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

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
 * Since the jackdaw-repo-split P0 this package is the CONTRACT package: subpath
 * modules (`version`, `turn-streaming`, `traces-format`, `types/*`, `lib/*`, …)
 * carry the small dependency-free constants and helpers both sides of the wire
 * share. This root index stays types-only; subpaths may hold runtime code but
 * must remain zero-dependency and browser-safe.
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
    }
  | { kind: 'shell'; cmd: string }
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
  | 'custom'
  // Runner-queue worker template (docs/runs.md) — never conversational.
  | 'worker';

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
  inject_journal?: boolean;
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
  /** Propose a follow-up question after each completed turn (the suggester
   *  worker's chip above the chat composer). Absent/false = off. */
  suggest_follow_up?: boolean;
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
  /** The co-admin login this agent is the personal assistant for (migration
   *  0143), or null for a shared agent. Set, it becomes that login's default
   *  chat target — the mechanism that keeps two people typing at once out of
   *  one interleaved thread. Not a privacy boundary: every login still sees
   *  and can open every agent. */
  assignedUserId: string | null;
  /** ISO timestamp of the current assignment; null when unassigned. */
  assignedAt: string | null;
  priority: number;
  enabled: boolean;
  /** True when this agent ships from the system manifest (a def-synced
   *  specialist). Since 2026-07-29 only its params/memoryConfig tuning
   *  re-syncs on upgrade — prompt, model, provider and key are operator-owned
   *  and survive. Drives the "system" badge on the agents screens. */
  manifestManaged: boolean;
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
  /** How many scope selections the drive has; 0 = syncing everything. */
  scopeCount: number;
}

/** One scope selection on a drive, as stored/returned by
 *  `GET/PUT /api/microsoft/drives/[id]/scopes`. Folder scopes include the
 *  whole subtree (path prefix); file scopes match that one item. */
export interface MsDriveScopeDTO {
  itemId: string;
  /** After-`root:` path, always starting with `/` (e.g. `/Reports/2026`). */
  path: string;
  isFolder: boolean;
  name: string | null;
}

/** One row of a drive-folder listing from
 *  `GET /api/microsoft/drives/[id]/browse` — the scope picker's navigation
 *  unit. Selection state is client-derived by matching against the scope set. */
export interface MsDriveChildDTO {
  itemId: string;
  name: string;
  isFolder: boolean;
  childCount: number | null;
  size: number | null;
  path: string | null;
  webUrl: string | null;
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
export type HeartbeatSurfaceDTO = { kind: 'telegram'; chat_id: string } | { kind: 'web' };

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

// ── Live turn streaming ─────────────────────────────────────────────────────────

/**
 * The cross-client contract for live "what the agent is doing" updates during a
 * turn — consumed identically by the web client and the Flutter companion (see
 * `docs/live-turn-streaming.md`). One event stream unifies coarse status, tool
 * activity, reasoning, and token deltas.
 *
 * This is the wire shape ONLY (zero-runtime, per this package's invariant): the
 * server-side channel + publisher + schema-version constant live in
 * `@mantle/turn-stream`; the producer stamps `v`/`seq`/`round`.
 *
 * Evolution rule: new `type`s and new `data` fields are additive (non-breaking) —
 * a client ignores a `type` it doesn't recognise. A breaking change to an
 * existing event's shape bumps `v` (`TURN_EVENT_SCHEMA_VERSION`).
 */
export type TurnEventType =
  | 'turn-start'
  | 'status'
  | 'tool-start'
  | 'tool-end'
  | 'reasoning-delta'
  | 'text-delta'
  | 'done'
  | 'error';

/** A pending outbound message now exists; the client can bind UI to `turnId`. */
export interface TurnStartData {
  agentSlug: string;
  /** Resolved model id, when known at turn start (else null). */
  model: string | null;
  /** Durable `assistant_messages` id of the inbound (user) row, persisted before
   *  the model runs. Lets a client swap its optimistic user bubble for the
   *  canonical row without waiting on the POST. Optional (additive): a client
   *  that predates this field ignores it. */
  inboundId?: string;
  /** Durable `assistant_messages` id of the outbound (reply) row, inserted
   *  `pending` at turn start. This is the turn's authoritative reconciliation
   *  handle — the client binds the reply bubble to it and, on `done`, reads the
   *  final text from this row (vs. the advisory streamed buffer). Optional. */
  outboundId?: string;
}

/** A short "what it's doing now" line ("Searching your brain…"). `kind` is an
 *  optional coarse bucket the UI can theme/iconify. `stepId` ties together the
 *  grounded line and its later narrated upgrade for the SAME step, so the client
 *  replaces the line in place rather than appending a duplicate. */
export interface TurnStatusData {
  label: string;
  kind?: string;
  /** Stable id for the step this status describes. Two events sharing a stepId
   *  are the same step (grounded → narrated); the client upserts by it. */
  stepId?: string;
  /** Present (true) only on the narrator's rephrased line for a step — the warm
   *  first-person paragraph. Grounded lines omit it. Lets clients keep narrated
   *  text visible while later grounded lines tick past. */
  narrated?: true;
}

/** A tool round began. `summary` is an optional one-line, secret-free preview. */
export interface TurnToolStartData {
  name: string;
  summary?: string;
}

/** A tool round finished (`ok=false` = it errored — the turn may still recover). */
export interface TurnToolEndData {
  name: string;
  ok: boolean;
}

/** A chunk of the model's reasoning stream (raw; may be curated before display). */
export interface TurnReasoningDeltaData {
  text: string;
}

/** A chunk of the visible reply text. */
export interface TurnTextDeltaData {
  text: string;
}

/** Terminal success. The client now reconciles against the durable message row;
 *  the streamed text is advisory, the DB row is authoritative. */
export interface TurnDoneData {
  status: 'complete';
  /** Real output-token total for the whole turn (summed across rounds). The
   *  client shows a streamed char-based estimate while the reply types out, then
   *  swaps it for this exact figure on `done`. Optional + additive: absent when
   *  no provider reported usage, or from a producer that predates the field. */
  tokensOut?: number;
}

/** Terminal failure. */
export interface TurnErrorData {
  status: 'failed';
  message: string;
}

/** Fields every turn event carries. */
export interface TurnEventBase {
  /** Schema version (`TURN_EVENT_SCHEMA_VERSION` at emit time). */
  v: number;
  /** Durable turn id = the outbound `assistant_messages` id. Stable for the turn. */
  turnId: string;
  /** Monotonic per-turn sequence — the SSE `id:` field and the resume cursor. */
  seq: number;
  /** Tool-loop round this event belongs to (0 = before the first round). */
  round: number;
}

/** One live turn event. Discriminated on `type`; `data` is the matching payload. */
export type TurnEvent =
  | (TurnEventBase & { type: 'turn-start'; data: TurnStartData })
  | (TurnEventBase & { type: 'status'; data: TurnStatusData })
  | (TurnEventBase & { type: 'tool-start'; data: TurnToolStartData })
  | (TurnEventBase & { type: 'tool-end'; data: TurnToolEndData })
  | (TurnEventBase & { type: 'reasoning-delta'; data: TurnReasoningDeltaData })
  | (TurnEventBase & { type: 'text-delta'; data: TurnTextDeltaData })
  | (TurnEventBase & { type: 'done'; data: TurnDoneData })
  | (TurnEventBase & { type: 'error'; data: TurnErrorData });

// ── ask_human questionnaire (runner queues) ───────────────────────────────────
// THE single source of truth for the questionnaire contract. The plan parser
// (@mantle/tools) validates against these caps, the answer path (@mantle/runs)
// re-checks submissions against them, and the client renders whatever they
// admit. They lived in three places once and immediately disagreed — the
// client's id fallback diverged from the server's, and the client had no
// question cap while the API capped answers at 4, so a 5-question form
// rendered fine and then 400'd on submit.

/** One selectable answer. `description` is the muted subtext on the chip. */
export interface AskHumanFormOption {
  label: string;
  description?: string;
}

/** One sub-question of a questionnaire. `id` is the routing key answers are
 *  submitted under; `header` is the short chip shown beside the question. */
export interface AskHumanFormQuestion {
  id: string;
  header?: string;
  question: string;
  options: AskHumanFormOption[];
  multi_select?: boolean;
  /** Free-text escape. Defaults ON — a question whose options don't fit and
   *  offers no way to say so forces a wrong answer. */
  allow_other?: boolean;
}

export interface AskHumanForm {
  questions: AskHumanFormQuestion[];
}

/** One answered sub-question, as submitted to `PATCH /api/pending/:id` and
 *  `pending_approve`. `question` is the form question's `id`. */
export interface AskHumanFormAnswer {
  question: string;
  selected: string[];
  other?: string;
}

/**
 * Caps on a questionnaire. These are a CONTRACT, not advice: every answer
 * surface renders whatever the parser admits, so an unbounded form is an
 * unanswerable screen — and a cap enforced on only one side is a 400 the
 * operator can't act on.
 */
export const ASK_HUMAN_FORM_LIMITS = {
  /** Ask more than this and the answers to the first few probably change what
   *  you still need to ask — use a later `ask_human` step. */
  maxQuestions: 4,
  maxOptions: 8,
  /** A header renders as a chip, not a sentence. */
  maxHeaderChars: 24,
  maxQuestionChars: 300,
  maxLabelChars: 80,
  maxDescriptionChars: 200,
  maxOtherChars: 2_000,
  /** The form rides in `run_items.payload` AND the pending row's args, and
   *  both are read into prompts. */
  maxFormJsonBytes: 8_000,
} as const;

// ── Row/DTO shapes moved from the server packages (jackdaw split P0) ─────────
// Sources: @mantle/content, @mantle/email, @mantle/microsoft, @mantle/agent-runtime
// re-export these names, so server code keeps its original import paths.

export type TaskRow = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JournalRow = {
  id: string;
  title: string;
  body: string;
  mood: string | null;
  category: string | null;
  entryDate: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventRow = {
  id: string;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  remindAt: string;
  reminderSentAt: string | null;
  /** IANA timezone (e.g. "Africa/Johannesburg") captured from the
   *  client at create time. Used for display only — `starts_at` is
   *  always a UTC instant so the reminder fires at the right moment
   *  regardless of where the agent process or DB run. Defaults to
   *  'UTC' if the client didn't supply one. */
  timezone: string;
  /** Recurrence frequency; 'none' for a one-shot event. */
  recur: RecurFreq;
  /** Optional end-of-series cutoff (ISO). null = repeats until deleted. */
  recurUntil: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Notion-style content width: centered/narrow vs full available space. */
export type PageWidth = 'narrow' | 'wide';

export type PageRow = {
  id: string;
  /** Parent page id, or null for a top-level page. Drives the /pages tree
   *  and the `childPage` card (Phase 4a sub-pages). */
  parentId: string | null;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: PageVisibility;
  width: PageWidth;
  createdAt: string;
  updatedAt: string;
};

export type AppRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  description: string | null;
  /** Number of declared api_tool slugs. */
  toolCount: number;
  /** Whether the published source has a green build (renders today). */
  hasBuild: boolean;
  /** Whether an uncommitted draft exists. */
  hasDraft: boolean;
  /**
   * The app's exposure: mode of its active share ('public' | 'team'), or null
   * when it has never been shared / the share is revoked (owner-only).
   */
  shareMode: ShareMode | null;
  /** Whether this app is the designated Team Hub (prefs.teamHubAppId). */
  isHub: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AppDetail = AppRow & {
  source: AppSource;
  draft: AppSource | null;
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
};

export type ProfilePreferences = {
  /** IANA timezone, e.g. 'Africa/Johannesburg'. UTC when not set. */
  timezone: string;
  /** The last zone the auto-from-location hook DERIVED (not necessarily the one
   *  in `timezone`, if the user manually overrode since). Used purely for
   *  hysteresis: the hook only acts when the freshly-derived zone differs from
   *  this, so it won't fight a manual change or re-switch every turn at the same
   *  place. See auto-timezone.ts. */
  lastAutoTimezone?: string;
  /** BCP-47 locale, e.g. 'en-GB'. Drives date/number/currency
   *  formatting. Falls back to en-GB to match the legacy pinned
   *  format-datetime behaviour, so existing UI doesn't shift for
   *  users who haven't visited /settings/profile yet. */
  locale: string;
  /** Avatar style id — the BRAIN's avatar visual language, applied to every
   *  generated avatar (the owner's and every agent's). Brain-level alongside
   *  colorTheme and the display fonts, because it is a branding choice, not a
   *  personal one: one style with a different seed per entity reads as one
   *  product, six unrelated styles at once read as noise. Individuality lives
   *  in `avatarSeed`, which stays personal. See @mantle/web-ui/avatar for the
   *  registry; unknown ids resolve to the default rather than stranding. */
  avatarStyle?: string;
  /** How much of the theme generated avatars take on: 'native' (the style's own
   *  palette), 'mixed' (themed background, original artwork — the default) or
   *  'theme' (theme colours throughout). Brain-level for the same reason as
   *  avatarStyle: it describes how this brain's avatars look, not one login's
   *  taste. Read via projectAvatarTint, never raw. */
  avatarTint?: string;
  /** Which generated background each area of the shell shows, as
   *  `area=style` pairs (`menu=waves,header=off`). Brain-level for the same
   *  reason as avatarStyle and colorTheme: it is the look of the product.
   *  `off` is a real, storable choice, see @mantle/web-ui/backgrounds. Areas
   *  on their default are omitted, so a default change still reaches brains
   *  that never chose. Read via projectBackgrounds, never raw. */
  backgrounds?: string;
  /** Seed for THIS user's avatar; the UI defaults it to the user id when unset
   *  so an avatar still renders. Personal — two admins share the brain's style
   *  but never the same avatar. */
  avatarSeed?: string;
  /** Slug of the responder agent whose Telegram bot delivers event reminders.
   *  Unset → the reminder worker falls back to the most-recently-active allowed
   *  DM (whichever bot you last messaged). Set it to pin reminders to one
   *  persona, e.g. 'telegram-default' (Saskia), so they don't come from
   *  whichever bot happened to be most recent. */
  reminderAgentSlug?: string;
  /** Where event reminders are delivered: 'telegram' (a bot DM) or 'mobile' (a
   *  push to the companion app). Auto-tracked — it follows the last channel the
   *  user actually messaged on (see noteInboundChannel), and can be set manually
   *  from the profile; a manual choice holds until the next message on the other
   *  channel supersedes it. Unset ⇒ the reminder worker defaults to 'telegram'
   *  (backward-compatible). See docs/reminder-delivery-routing.md. */
  reminderChannel?: ReminderChannel;
  /** What the user likes to be called (captured during onboarding). Cosmetic —
   *  the assistant's real knowledge of the user comes from the Journal identity
   *  block; this is for greetings/UI. */
  displayName?: string;
  /** Custom site name rendered as the header wordmark in place of "mantle" —
   *  a per-box label (e.g. 'Refinery') so anyone with several brains can see at
   *  a glance which one they're on. Cosmetic only; unset ⇒ the Mantle wordmark.
   *  Read via projectSiteName, never raw. */
  siteName?: string;
  /** This brain's peer name — shown in the header CENTRE (replacing the old page
   *  title) as this node's federation-facing identity label. Cosmetic; unset ⇒
   *  the header centre is empty. Read via projectPeerName, never raw. */
  peerName?: string;
  /** The owner's writing conventions, in their own words — appended to EVERY
   *  agent's composed system prompt as a `## House style` block (see
   *  composeSystemPromptWithSkills). Brain-level, because it describes how this
   *  brain writes, not how one login works.
   *
   *  Free text rather than a checkbox on purpose: the first rule anyone wants
   *  is "no em dashes", the second is "don't say 'delve'", and a boolean per
   *  rule is a migration per taste. Unset ⇒ no block is emitted at all, so the
   *  cached prompt prefix is byte-identical to before the feature existed.
   *  Read via projectHouseStyle, never raw. */
  houseStyle?: string;
  /** The UI colour-theme id (the header theme toggler / random shuffle). The
   *  DB copy is the source of truth so the choice follows the owner across
   *  browsers and brands member-facing surfaces (/s, /team) — localStorage
   *  stays only as the before-paint fast path. Unset ⇒ the default theme.
   *  Read via projectColorTheme, never raw. */
  colorTheme?: string;
  /** Selectable header WORDMARK font key (Settings → Appearance → Fonts). The
   *  font LIST lives in the web app (apps/web/lib/display-fonts.ts); the server
   *  stores any well-formed slug and the client falls back to the default for
   *  keys it doesn't know, so trimming the library never strands the preference.
   *  Unset ⇒ the default wordmark face (Bricolage Grotesque). Read via
   *  projectFontKey, never raw. */
  fontLogo?: string;
  /** Selectable header page-TITLE font key — same contract as `fontLogo`.
   *  Unset ⇒ the default UI sans. Read via projectFontKey, never raw. */
  fontTitle?: string;
  /** The INTERFACE font key — what the whole UI is set in, not just a header
   *  ornament. Same contract as `fontLogo`; unset ⇒ Inter (the always-loaded
   *  next/font face). Read via projectFontKey, never raw. */
  fontUi?: string;
  /** The PAGES/NOTES font key — what long-form prose is set in, in the editor,
   *  on shared pages, and in the PDF export. Same contract as `fontLogo`; unset
   *  ⇒ 'inherit' (follow the interface font). This is the one slot where the
   *  choice leaves the browser: a page exported to PDF is typeset in it. */
  fontProse?: string;
  /** UI scale: 'xsmall' | 'small' | 'medium' | 'large'. Drives the ROOT
   *  font-size, so the rem-based shell scales with it rather than only the
   *  letters. Unset ⇒ 'medium'. Read via projectFontSize, never raw. */
  fontSize?: string;
  /** Wordmark scale — same vocabulary as `fontSize`, but a LOCAL multiplier on
   *  one element rather than the root font-size (a wordmark that rescaled the
   *  whole shell would be a bug). Unset ⇒ 'medium'. */
  fontLogoSize?: string;
  /** Peer-name scale. Same contract as `fontLogoSize`. */
  fontTitleSize?: string;
  /** Pages/Notes prose scale. Same contract as `fontLogoSize`. */
  fontProseSize?: string;
  /** Brand logo: the content-addressed storage key of the uploaded image
   *  (attachments/aa/bb/<sha256> — @mantle/storage contentKey). Set/cleared
   *  ONLY via PUT/DELETE /api/profile/logo, which validates the bytes; when
   *  set, both headers render the image in place of the siteName wordmark.
   *  The sha in the key doubles as the cache-busting version. Read via
   *  projectLogoKey, never raw. */
  logoKey?: string;
  /** The logo's mime type, from the validated upload (svg/png/jpeg/webp
   *  allowlist — projectLogoType). The public serve route replays it. */
  logoType?: string;
  /** Optional DARK-MODE logo variant — same storage/validation contract as
   *  logoKey, uploaded via PUT /api/profile/logo?variant=dark. Renderers show
   *  it when the UI is in dark mode and fall back to the base logo (then the
   *  wordmark) when unset — so a light-on-transparent mark stays readable on
   *  both themes without forcing every brain to upload two files. */
  logoDarkKey?: string;
  /** The dark variant's mime type (same allowlist as logoType). */
  logoDarkType?: string;
  /** Free-text "what this brain is for" — captured at onboarding, editable in
   *  Settings → Profile. Injected as the "# Purpose of this brain" section of the
   *  always-on identity block (identity-context.ts), so every agent knows the
   *  brain's mission. */
  purpose?: string;
  /** The brain's speciality archetype key (see onboarding-questions.ts
   *  PURPOSE_ARCHETYPES — 'personal' | 'analytics' | 'research' | 'robotics' |
   *  'team' | 'custom'). Descriptive for now; the seam a later phase can branch
   *  default provisioning on. */
  purposeArchetype?: string;
  /** ISO instant onboarding was completed. Unset ⇒ the onboarding wizard runs
   *  on next login; the (app) shell redirects there. Set ⇒ shell renders normally. */
  onboardedAt?: string;
  /** Resume marker for the onboarding wizard — the key of the furthest step the
   *  user has reached. Lets a refreshed/re-entered wizard pick up where it left off. */
  onboardingStep?: string;
  /** Model choices captured by the onboarding "Models" step — the operator
   *  overlay `provisionDefaults()` applies on top of the manifest seed (the
   *  assistant's chat model + the indexing workers' fast model). When
   *  `route: 'azure'`, those rows are pinned to an Azure OpenAI endpoint via
   *  the `custom` provider (key stored under service `custom`). */
  onboardingModels?: OnboardingModelChoices;
  /** When true, tools an AGENT authors (via Toolsmith / api_tool_create) start
   *  confirm-gated: every call parks for operator approval until the operator
   *  clears "requires confirm" for that tool in Settings → Tools. Defaults
   *  OFF — a simple single-owner brain trusts itself; turn it ON if you grant
   *  tool-authoring to an agent that reads untrusted content (email/web), so an
   *  injected agent can't stand up a silent exfiltration endpoint. Independent
   *  of the always-on guards (self-grant block, no-lower-via-update, SSRF). */
  toolsmithRequireApproval?: boolean;
  /** APP_VERSION the boot-time manifest reconcile last synced this brain to.
   *  The reconcile (apps/web instrumentation → reconcileManifestOnBoot) runs once
   *  per version on a deployed/updated instance, so a self-hoster who only pulls a
   *  new image still gets new tools/skills/group-membership without running seed
   *  scripts. Equal to APP_VERSION ⇒ already reconciled, skip. */
  lastReconciledVersion?: string;
  /** When true, outbound/egress tools (email_send, web_fetch, web_search)
   *  fired during an UNATTENDED heartbeat run park for operator approval
   *  instead of executing inline. Only tools that reach OUT are gated — the
   *  heartbeat's own surface reply (the final Telegram message) is not a tool
   *  and still goes through. Defaults OFF: most heartbeats are trusted
   *  routines. Turn it ON for an agent that reads untrusted content on a
   *  timer, so an injected instruction can't silently email or fetch on your
   *  behalf while you're away. Pairs with the interactive Telegram approval
   *  card so a parked egress call can be cleared from a phone. */
  heartbeatEgressGate?: boolean;
  /** Show the live "thinking" trail + stream the reply token-by-token in the
   *  /assistant chat (and the companion). **Defaults ON** (undefined → on); set
   *  false to fall back to a static thinking bubble + the reply appearing whole
   *  on completion. This is the per-brain runtime control for live turn
   *  streaming; the `MANTLE_TURN_STREAMING` env var is a deploy-level override
   *  (env off wins). Read by the web turn route (202 vs blocking + the SSE gate)
   *  via `isStreamThoughtsEnabled`. */
  streamThoughts?: boolean;
  /** How the LIVE thinking trail renders during a turn: 'list' stacks completed
   *  actions above the active line (default); 'replace' shows only the current
   *  action, each one replacing the last (compact, single line). The frozen
   *  record view (after the turn) is unaffected. */
  thoughtTrailMode?: ThoughtTrailMode;
  /** Persist the thought trail onto the finished message so it survives a page
   *  refresh — reconstructed from the turn's tool actions and stored on the
   *  durable row, so it reloads on web AND the companion. **Defaults ON**; set
   *  false to keep it ephemeral (in-memory only; clears on reload). See
   *  `isPersistThoughtsEnabled`. */
  persistThoughts?: boolean;
  /** Per-user thinking budget in tokens. Real model reasoning is requested only
   *  when the live-thinking switch is ON (`streamThoughts`) AND this is > 0;
   *  0 / unset = no thinking. Maps to the provider's knob in the adapters
   *  (Anthropic adaptive, OpenRouter `reasoning.max_tokens`, Gemini
   *  `thinkingConfig`, Copilot `reasoning_effort`). This is the per-user
   *  replacement for the old per-box `MANTLE_THINKING_BUDGET` env gate. Resolve
   *  via `resolveThinkingBudget` — never read raw, so the switch gate always
   *  applies. **Defaults unset (off).** */
  thinkingBudget?: number;
  /** Whether this box exposes its remote MCP connector (the OAuth-gated
   *  `/api/mcp` endpoint addable as a claude.ai custom connector). **Defaults
   *  OFF** — it's an explicit opt-in because it puts the tool surface on the
   *  public internet (behind OAuth). When off, `/api/mcp` + the OAuth
   *  authorize/register endpoints 404, so no new client can connect and existing
   *  tokens stop working. Flip it in Settings → MCP. */
  remoteMcpEnabled?: boolean;
  /** Whether the external Team Chat responder may read the owner's PRIVATE
   *  corpus — email + journal — on a team member's behalf. **Defaults OFF**:
   *  team members always get brain-wide knowledge reads (search, files, notes,
   *  pages, tables, tasks, contacts, app data), but the owner's personal email
   *  history and journal stay off-limits unless this is explicitly turned on.
   *  Enforced at the team turn's tool resolution (`isTeamPrivateReadsEnabled`
   *  strips `email_*`/`journal_*` when off), independent of the `team-read`
   *  group grant, so the switch can't be bypassed by a manifest change. Flip it
   *  from the Team admin surface. */
  teamPrivateReads?: boolean;
  /** Node id of the mini-app designated as this brain's TEAM HUB. When set (and
   *  the app has a green published build + an active team-mode share), the /team
   *  shell renders that app full-bleed in place of the built-in hub body; the
   *  built-in hub remains the fallback for every other state. Resolve via
   *  `resolveTeamHubApp` (team-hub.ts), never raw — designation is only honoured
   *  when the whole chain (pref → app → build → share) is intact. Read via
   *  projectTeamHubAppId, never raw. */
  teamHubAppId?: string;
  /** Tags the owner curates as Dashboard sections on the /team overview: each
   *  tag renders a section of up to 5 team-visible shared pages carrying it
   *  (newest-updated first, title + summary + /s link). Order here = section
   *  order. The share stays the single source of truth for WHAT is visible —
   *  this pref only chooses which tag groupings get pinned. Unset/empty ⇒ no
   *  curated sections. Read via projectTeamHubTags, never raw. */
  teamHubTags?: string[];
};

export type BackupConfig = {
  enabled: boolean;
  frequency: BackupFrequency;
  /** Hour of day (0-23) in the USER's timezone (profiles.preferences.timezone). */
  hour: number;
  /** Newest N dumps retained in the directory. */
  keep: number;
  /** Absolute destination directory. Empty/unset → resolveBackupDir default. */
  location?: string;
};

export type BackupFile = { name: string; bytes: number; mtime: string };

export type BackupStatus = {
  lastRunAt: string;
  ok: boolean;
  /** Set when ok=false. */
  error?: string;
  file?: string;
  bytes?: number;
  durationMs?: number;
  /** 'schedule' | 'manual' — what triggered the run. */
  trigger: string;
  /** When the last SUCCESSFUL run finished — preserved across failed runs,
   *  so the /debug/integrity staleness check can tell "failing for a week"
   *  from "failed once after last night's good dump". */
  lastSuccessAt?: string;
  /** Sqlite-native table workbooks snapshotted beside the dump (durability
   *  gate 2). failed>0 is surfaced in the settings card — a backup that
   *  silently skips a workbook is the gap this closes. */
  tableDbs?: { snapshotted: number; missing: number; failed: number };
  /** Per-app mini-app SQLite databases snapshotted beside the dump. Same
   *  durability gate as tableDbs: these live on their own volume, so pg_dump
   *  alone misses them and a scheduled backup would silently omit all app
   *  data (e.g. a Team Hub app's DB) without this pass. */
  appDbs?: { snapshotted: number; missing: number; failed: number };
};

export type CuratedTeamSection = {
  /** The curated tag — the section heading (display-cased by the UI). */
  tag: string;
  /** Up to {@link TEAM_CURATED_SECTION_LIMIT} team-visible page shares carrying
   *  the tag, newest node update first. */
  items: TeamVisibleShare[];
};

export type TeamMemberActivity = {
  contactId: string;
  /** Contact node title; '(deleted contact)' can't occur here — membership
   *  rows cascade with the contact. */
  contactName: string;
  memberSince: string;
  tokenLastUsedAt: string | null;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
  /** Member inbound messages since the owner last read this thread in
   *  /team-admin (all inbound when never read). Drives the unread badge. */
  unread: number;
};

export type TeamRequest = {
  taskId: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  priority: string;
  createdAt: string;
  /** Provenance from data.teamRequest — null contactId means a malformed row
   *  (shouldn't happen; team_request_create always stamps it). */
  contactId: string | null;
  contactName: string | null;
  /** When the owner last posted a resolution to the member for this request. */
  notifiedAt: string | null;
};

export type ForumTopicListItem = {
  id: string;
  title: string;
  kind: ForumTopicKind;
  visibility: ForumTopicVisibility;
  pinned: boolean;
  status: ForumTopicStatus;
  authorName: string;
  createdByContactId: string | null;
  postCount: number;
  lastPostAt: string;
  createdAt: string;
  lastPostAuthor: string | null;
  lastPostPreview: string | null;
  /** Posts by OTHERS since this viewer last read the topic (all of them when
   *  never read). Drives the unread dot. */
  unread: number;
};

export type ForumMemberActivity = {
  contactId: string;
  postCount: number;
  topicsStarted: number;
  lastPostAt: string | null;
  lastPostBody: string | null;
  lastPostTopicTitle: string | null;
  /** This member's posts newer than the OWNER's read cursor on the containing
   *  topic. Deliberately only cleared by opening the TOPIC — reading someone's
   *  activity feed is not reading the thread the whole room saw. */
  unread: number;
};

export type ForumMemberPost = {
  id: string;
  body: string;
  createdAt: string;
  /** Set when this post filed a review/feature/bug request. */
  kind: ForumPostRequestKind | null;
  attachments: ConversationAttachment[];
  topicId: string;
  topicTitle: string;
  topicVisibility: ForumTopicVisibility;
  topicStatus: ForumTopicStatus;
  /** The agent's answer to THIS post, or null when the turn was waved off
   *  ("no answer needed") or is still owed. */
  reply: {
    id: string;
    body: string;
    authorName: string;
    traceId: string | null;
    status: 'pending' | 'complete' | 'failed';
    error: string | null;
    createdAt: string;
  } | null;
};

export type ForumAuthoredTopic = {
  id: string;
  title: string;
  kind: ForumTopicKind;
  visibility: ForumTopicVisibility;
  status: ForumTopicStatus;
  pinned: boolean;
  postCount: number;
  lastPostAt: string | null;
  createdAt: string;
};

export type PendingForumUpload = {
  id: string;
  topicId: string | null;
  postId: string | null;
  topicTitle: string | null;
  contactId: string | null;
  contactName: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
};

export type AccountFoldersResult =
  | {
      ok: true;
      address: string;
      /** Every folder the server reports right now (the pick list). */
      allFolders: string[];
      /** The current explicit allow-list, or null = "scan all non-excluded". */
      included: string[] | null;
      /** Folders the operator opted OUT of (rendered disabled). */
      excluded: string[];
      /** Folders the sync has actually touched (per the cursor). */
      scanned: string[];
    }
  | { ok: false; error: string };

export interface FolderFacet {
  folder: string;
  count: number;
  unread: number;
}

export interface MessageListItem {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: Date;
  isRead: boolean;
}

export interface MsConfigStatus {
  configured: boolean;
  /** Where the active config comes from — drives the UI ("set here" vs "from
   *  environment, read-only"). */
  source: 'db' | 'env' | null;
  clientId: string | null;
  tenant: string;
  redirectUri: string | null;
  /** Masked secret for display; never the plaintext. */
  secretMasked: string | null;
}

/** One retrieved (or near-miss) item: capped text + its ranking distance. */
export type SnapshotItem = {
  text: string;
  /** Ranking distance (cosine, salience/recency-adjusted where the section
   *  ranks that way). Null for always-injected items (preferences) that
   *  bypass the vector race. */
  dist: number | null;
  kind?: string | null;
  entity?: string | null;
  nodeId?: string | null;
  title?: string | null;
  heading?: string | null;
};

export type ContextSnapshot = {
  query: {
    /** The inbound text as given to retrieval (snipped). */
    inbound: string;
    /** The anaphora-enriched text actually embedded, when it differs. */
    enriched: string | null;
    /** False when embedding was skipped or failed — retrieval ran blind. */
    embedded: boolean;
  };
  facts: { sent: SnapshotItem[]; dropped: SnapshotItem[]; guard: number };
  contentHits: { sent: SnapshotItem[]; dropped: SnapshotItem[]; cutoff: number };
  chunkHits: { sent: SnapshotItem[]; dropped: SnapshotItem[]; cutoff: number };
  relations: string[];
  digests: { count: number; topics: string[] };
  history: {
    count: number;
    /** How many outbound turns carried a [tool record: …] read-back suffix. */
    toolRecords: number;
    /** How many turns carried a [media record: …] read-back suffix. */
    mediaRecords: number;
  };
  personaNotes: { count: number };
  corpusMap: { count: number; truncated: boolean };
};

export type BackupFrequency = 'daily' | 'weekly';

export type PageVisibility = 'private' | 'public';

/**
 * Recurrence frequencies an event can repeat on. `none` is the default —
 * a one-shot event. The reminder worker rolls a recurring event's single
 * row forward to its next occurrence after each ping (no instance
 * materialisation), so one node always represents the next upcoming hit.
 */
export type RecurFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Transports that can deliver a reminder out-of-band. A browser ('web') can't
 *  receive a push, so it never becomes a reminder target. */
export type ReminderChannel = 'telegram' | 'mobile';

/** Live thinking-trail display modes. */
export type ThoughtTrailMode = 'list' | 'replace';

/** The onboarding "Models" step's stored choices. Kept as one object so the
 *  projection can't half-apply; every field optional so partial saves survive. */
export interface OnboardingModelChoices {
  /** OpenRouter slug for the assistant/persona agent (e.g. `anthropic/claude-sonnet-4.6`). */
  assistantModel?: string;
  /** OpenRouter slug for the indexing workers (e.g. `google/gemini-3.1-flash-lite`). */
  workerModel?: string;
  /** Where the models run: OpenRouter (default) or an Azure OpenAI endpoint. */
  route?: 'openrouter' | 'azure';
  /** Azure OpenAI base URL (the OpenAI-compatible v1 endpoint), when route=azure. */
  azureBaseUrl?: string;
}

/**
 * Who a share admits. Lives in `shares.settings.mode` (absent = 'public', so
 * every pre-existing share keeps its behavior).
 *
 *   public — anyone with the link (the original model).
 *   team   — the visitor must additionally present a live team credential
 *            (see @mantle/content/team-tokens). Enforced for every kind on
 *            the /s/ surface (page render, asset bytes, app brokers).
 *            Team-mode PAGE shares double as the /team hub's briefing
 *            sections (see ./team-hub).
 */
export type ShareMode = 'public' | 'team';

export type TeamVisibleShare = {
  /** Share token — the workspace opens /s/<token>. */
  token: string;
  nodeId: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
  /** 'team' or 'public' — a member may open both, the badge tells them apart. */
  mode: 'team' | 'public';
  /** Parent node id — lets the pages section rebuild the sub-page tree over
   *  the SHARED subset (an unshared parent leaves its children as roots). */
  parentId: string | null;
  tags: string[];
};

// ── Mirrors of @mantle/db jsonb/enum shapes (jackdaw split P0) ────────────────
// Kept standalone so this package stays zero-dep (same convention as ToolHandler
// above). Drift is caught where the server builds these DTOs from db rows —
// an incompatible change there is a compile error at the row-builder.

/** Task lifecycle vocabulary — mirrors content's TASK_STATUSES/TASK_PRIORITIES
 *  consts, which are `satisfies`-checked against these unions. */
export type TaskStatus = 'open' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high';

/** Mirrors @mantle/db `ForumTopicKind`. */
export type ForumTopicKind = 'question' | 'review' | 'feature' | 'bug' | 'discussion';
/** Mirrors @mantle/db `ForumTopicVisibility`. */
export type ForumTopicVisibility = 'team' | 'private';
/** Mirrors @mantle/db `ForumTopicStatus`. */
export type ForumTopicStatus = 'open' | 'answered' | 'closed';
/** Mirrors @mantle/db `ForumPostRequestKind` — the topic kinds that file an
 *  owner review task. */
export type ForumPostRequestKind = 'review' | 'feature' | 'bug';

/** Mirrors @mantle/db `ConversationAttachment` (jsonb on conversation rows). */
export type ConversationAttachment = {
  kind: 'image' | 'audio' | 'voice' | 'document' | 'video';
  mime?: string;
  caption?: string;
  nodeId?: string;
  fileId?: string;
  url?: string;
};

/** Mirrors @mantle/db `AppSource` — a mini app's virtual file tree. */
export type AppSource = {
  /** Path of the entry module within `files`; must `export default App`. */
  entry: string;
  /** path → TSX/TS source. Bounded (~30 files / ~256 KB) to stay a mini app. */
  files: Record<string, string>;
};

/** Mirrors @mantle/db `AppManifest` — the runtime contract for a running app. */
export type AppManifest = {
  toolSlugs?: string[];
  sqlite?: { schemaSql: string; schemaVersion: number };
  description?: string;
};

/** Mirrors @mantle/db `BuildRef` — pointer to a bundled artifact in storage. */
export type BuildRef = {
  storageKey: string;
  sha256: string;
  builtAt: string;
  esbuildVersion: string;
  bytes: number;
  ok: boolean;
  warnings?: string[];
};

// ── Redacted account DTOs (hand-mirrored; jackdaw split P0) ───────────────────
// These mirror db-derived server types (`Omit<EmailAccount,…>` etc.) that can't
// be re-exported without dragging the postgres type graph in. Timestamps are
// ISO strings here — the wire truth — where the server-side originals carry
// `Date`. Key-set drift checks live next to the server definitions
// (email/accounts.ts, microsoft/accounts.ts, email's sync-runs consumer).

/** Mirrors @mantle/email `PublicEmailAccount` (an `email_accounts` row minus
 *  the sealed IMAP secret). */
export interface PublicEmailAccount {
  id: string;
  userId: string;
  provider: 'gmail' | 'microsoft' | 'imap';
  address: string;
  displayName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  /** @deprecated historical reads only (migration 0002). */
  imapFolders: string[];
  imapExcludedFolders: string[];
  imapIncludedFolders: string[] | null;
  firstScanDays: number;
  ingestPolicy: 'approve_list' | 'block_list';
  branchPath: string;
  msAccountId: string | null;
  syncState: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors @mantle/db `SyncRun` (a `sync_runs` row) as it crosses the wire. */
export interface SyncRun {
  id: string;
  accountId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'ok' | 'error';
  scanned: number;
  ingested: number;
  error: string | null;
}

/** Mirrors @mantle/microsoft `PublicMsAccount` (an `ms_accounts` row with the
 *  sealed OAuth tokens replaced by presence flags). */
export interface PublicMsAccount {
  id: string;
  userId: string;
  upn: string;
  displayName: string | null;
  tenantId: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  branchPath: string;
  surfaces: Record<string, boolean>;
  syncState: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

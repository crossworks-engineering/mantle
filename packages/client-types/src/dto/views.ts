/**
 * @mantle/client-types · views
 *
 * Server-lib view/query DTOs — the shapes screens read, kept here so a
 * client component never reaches into @server/*.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

import type { AuditSeverity, SystemReport } from '../types/integrity';
import type { TraceDetail } from '../traces-format';
import type { PersonaNoteDTO } from './agents';
import type { ContextSnapshot, ConversationAttachment } from './rows';

// ── Server-lib view/query DTOs (jackdaw split P0 follow-up: @server/* purge) ──
// Moved from server/web/lib/* and @mantle/content; the originals re-export
// these names so server import paths are unchanged.

/** Sort order for the pages list. 'edited' (last updated) is the default. */
export type PageSort = 'edited' | 'newest' | 'oldest' | 'title';

/** A node that links TO a given page — one inbound `references` edge, resolved
 *  to its source node. Powers the "Referenced by" panel. */
export type Backlink = {
  id: string;
  title: string;
  /** The source node's type (wire truth: the db enum widens to string here). */
  type: string;
  icon: string | null;
};

export type CapacityZone = 'green' | 'watch' | 'split';

export type CapacityMetric = {
  count: number;
  watch: number;
  split: number;
  /** count / split — may exceed 1 when the split point is passed. */
  ratio: number;
  zone: CapacityZone;
};

export type BrainCapacity = {
  docs: CapacityMetric;
  chunkVectors: CapacityMetric;
  /** Worst zone across both axes — the brain's headline state. */
  zone: CapacityZone;
  /** Worst-axis fill as an integer percentage of the split budget (may exceed 100). */
  pctOfSplit: number;
};

export type AgentContext = {
  agentId: string;
  agentName: string | null;
  agentSlug: string | null;
  modelSlug: string;
  lastTokensIn: number;
  contextLimit: number | null;
  /** Where contextLimit came from: live OpenRouter data, the static
   *  fallback, or unknown (slug not in either). Surfaced in the UI. */
  contextSource: ContextSource;
  pct: number | null;
  lastRunAt: string;
};

export type SpendRange = 'day' | 'week' | 'month';

export type AgentSpend = {
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  runs: number;
};

export type ModelSpend = {
  /** The OpenRouter model slug captured in trace_steps.meta.model. */
  model: string;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  calls: number;
};

export type DailySpend = {
  /** ISO date (YYYY-MM-DD) in the server's local timezone. */
  day: string;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  runs: number;
};

export type RecentFailure = {
  id: string;
  kind: string;
  startedAt: string;
  error: string;
};

export type TopError = {
  message: string;
  count: number;
  lastAt: string;
  lastTraceId: string;
};

/** Per-tool tallies of calls the central validator flagged. Clean calls
 *  write no `arg_validation` meta at all, so these are problem counts,
 *  not rates — an empty result means nothing was flagged, not no calls. */
export type ToolValidationAgg = {
  tool: string;
  flaggedCalls: number;
  withRepairs: number;
  withUnknownKeys: number;
  withViolations: number;
  lastAt: string;
};

export type ToolValidationEvent = {
  stepId: string;
  traceId: string;
  tool: string;
  mode: string;
  repairs: Array<{ key: string; kind: string; note: string }>;
  unknownKeys: Array<{ key: string; suggestion: string | null }>;
  violations: string[];
  startedAt: string;
};

export type AgentActivityRow = {
  id: string;
  slug: string;
  name: string;
  role: string;
  model: string;
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
};

export type ChatRow = {
  id: string;
  title: string | null;
  username: string | null;
  telegramChatId: string;
  allowlistStatus: string;
  totalTurns: number;
  digested: number;
  undigested: number;
  lastActivity: string | null;
  responderAgentId: string | null;
};

export type PersonaNotesRow = {
  agentId: string;
  agentName: string;
  agentSlug: string;
  notes: PersonaNoteDTO[];
};

export type ContentIndexCoverage = {
  total: number;
  indexed: number;
  byType: Array<{ type: string; total: number; indexed: number }>;
};

/**
 * Awareness of duplicate graph edges. Going forward the extractor rebuilds
 * edges per node (idempotent), but content re-edited *before* that fix may
 * carry historical duplicate `mentioned_in` / `references` rows. This surfaces
 * the count + a few labelled samples so the operator knows to run
 * `pnpm dedupe:edges`. Read-only — cleaning stays the deliberate CLI tool.
 */
export type DuplicateEdgeStats = {
  groups: number; // logical edges with >1 row
  redundant: number; // rows that could be removed (sum of count-1)
  samples: { relation: string; label: string; count: number }[];
};

/** One responder turn: the question, the retrieval snapshot the turn's
 *  'load_context' trace step persisted (null for pre-instrumentation turns),
 *  and the outbound reply. See ContextSnapshot in @mantle/runtime/agent. */
/** Mirrors @mantle/tracing `ContextSource`. */
export type ContextSource = 'live' | 'fallback' | 'unknown';

export type ContextTurnRow = {
  traceId: string;
  startedAt: string;
  status: string;
  surface: string | null;
  agentSlug: string | null;
  model: string | null;
  durationMs: number | null;
  question: string | null;
  snapshot: ContextSnapshot | null;
  response: string | null;
};

export type DigestRow = {
  id: string;
  title: string;
  createdAt: string;
  /** All fields below are pulled out of nodes.data (jsonb). */
  chatId: string;
  telegramChatId: string | null;
  periodStart: string;
  periodEnd: string;
  sourceTurnCount: number;
  model: string;
  agent: string;
  summary: string;
  topic: string | null;
  topicSlug: string | null;
};

export type FactRow = {
  id: string;
  content: string;
  kind: string;
  confidence: number;
  entityName: string | null;
  entityKind: string | null;
  sourceNodeId: string | null;
  sourceTitle: string | null;
  createdAt: string;
};

export type TopicRow = {
  topic: string;
  topicSlug: string;
  digestCount: number;
  turnCount: number;
  firstSeen: string;
  lastSeen: string;
};

/** One key/count bucket in the corpus histograms below. */
export type Bucket = { key: string; count: number };

export type BrainCounts = {
  nodesTotal: number;
  nodesByType: Bucket[];
  factsTotal: number;
  factsByKind: Bucket[];
  entitiesTotal: number;
  entitiesByKind: Bucket[];
  edgesTotal: number;
  edgesByRelation: Bucket[];
};

/** A health check, not a fixer. Counts active edges that share the same
 *  (source, target, relation) — i.e. duplicates. The extractor's
 *  delete-then-rebuild discipline (see architecture §9k) means this should
 *  stay 0; a non-zero value flags a regression in edge writing. The remedy is
 *  the one-shot `pnpm dedupe:edges --apply`, NOT a recurring auto-clean (which
 *  would mask the regression). */
export type GraphIntegrity = {
  /** Distinct (source, target, relation) groups with more than one row. */
  duplicateEdgeGroups: number;
  /** Total redundant rows across those groups (Σ count-1) — how many
   *  `dedupe:edges --apply` would remove. */
  redundantEdgeRows: number;
};

export type VectorCounts = {
  nodesIndexed: number;
  nodesTotal: number;
  factsIndexed: number;
  factsTotal: number;
  entitiesIndexed: number;
  entitiesTotal: number;
  /** The headline: total embedded vectors across nodes + facts + entities. */
  vectorsTotal: number;
  /** Global content-addressed embedding cache (not owner-scoped). */
  embeddingCacheRows: number;
};

export type EmailStats = {
  total: number;
  unread: number;
  withAttachments: number;
  byAccount: { accountId: string; address: string; total: number; unread: number }[];
  latestSync: {
    accountId: string;
    address: string;
    status: string;
    finishedAt: string | null;
    ingested: number;
    scanned: number;
    error: string | null;
  }[];
};

export type HeartbeatStats = {
  byStatus: Bucket[];
  recentFiresByDisposition: Bucket[];
};

export type TelegramStats = {
  messagesTotal: number;
  unprocessed: number;
  chatsByStatus: Bucket[];
};

export type IngestDay = {
  day: string; // YYYY-MM-DD
  total: number;
  byType: Record<string, number>;
};

/** One model as shown in the explorer. Normalised fields are best-effort
 *  (absent when the provider's API doesn't return them); `raw` is always the
 *  untouched object the API gave us. */
export type ExplorerModel = {
  /** Provider model id / slug (e.g. 'anthropic/claude-sonnet-4.6'). */
  id: string;
  /** Friendly display name if the API provides one. */
  name?: string;
  description?: string;
  /** Total context window in tokens. */
  contextTokens?: number;
  /** Max output/completion tokens, when stated separately. */
  maxOutputTokens?: number;
  /** USD per 1M input (prompt) tokens. 0 means free; undefined means unknown. */
  inputPricePerM?: number;
  /** USD per 1M output (completion) tokens. */
  outputPricePerM?: number;
  /** Other priced dimensions the API exposes, surfaced verbatim. */
  extraPricing?: { label: string; value: string }[];
  /** e.g. 'text+image→text'. */
  modality?: string;
  /** Coarse type: chat | embedding | image | tts | stt | rerank | other. */
  kind?: string;
  /** Release/creation time as ISO, when provided. */
  created?: string;
  /** The provider's untouched model object. */
  raw: unknown;
};

export type ModelSort = 'name' | 'context' | 'input' | 'output' | 'created';

export type StudioNode = {
  /** Stable canvas id, namespaced by kind: `agent:<slug>` / `skill:<slug>`. */
  id: string;
  kind: StudioNodeKind;
  slug: string;
  label: string;
  /** Secondary line — model for agents, tool-count for skills. */
  sublabel: string;
  enabled: boolean;
  isPersona: boolean;
  /** Node-local referential problems (dangling tool/skill/delegate, disabled). */
  issues: string[];
};

export type StudioEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'skill' | 'delegate' | 'group';
};

export type NodeBiographyView = {
  node: {
    id: string;
    type: string;
    title: string;
    path: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    /** First N chars of the summary the extractor wrote — null if
     *  the extractor hasn't run (or refused to). */
    summary: string | null;
    /** True when the node has an embedding vector — second half of
     *  the "is this node ready for retrieval?" check. */
    hasEmbedding: boolean;
    /** Bytes of the content field (text-shaped nodes) or 0
     *  otherwise. Useful for "did extractor skip because body too
     *  short?" debugging. */
    contentChars: number;
    /** First 4KB of content. Lets the biography page show a quick
     *  preview of what was actually saved. */
    contentPreview: string | null;
    /** The data jsonb truncated and key-summarised so we don't blow
     *  up the page rendering a 1MB blob inline. */
    dataKeys: string[];
  };
  /** Traces in chronological order (oldest first). Operators read
   *  these top-to-bottom as a story: ingest → extractor → ... */
  traces: TraceDetail[];
  stats: {
    totalTraces: number;
    totalCostMicroUsd: number;
    totalTokensIn: number;
    totalTokensOut: number;
    /** ISO timestamp of the earliest trace touching this node, or
     *  the node's own createdAt if there are no traces. */
    firstSeen: string;
    /** ISO timestamp of the most recent trace. Equal to firstSeen
     *  when there's only one. */
    lastTouched: string;
    /** Counts by kind + status for the header chips. */
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
  };
};

export type AssistantAgentOption = {
  id: string;
  slug: string;
  name: string;
  role: string;
  model: string;
};

export type AssistantTimelineRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model: string | null;
  /** Transport the turn arrived/left on — drives the channel badge in the UI.
   *  'web' for native /assistant turns; 'telegram' (etc.) for turns that came
   *  in on another surface and now show in the unified stream. */
  channel: string;
  /** Execution state (migration 0105). 'complete' for every historical/inbound
   *  row; an outbound row is 'pending' while the durable runner works and
   *  'failed' if it errored — so a reload mid-turn renders a live "thinking…"
   *  bubble (or the error) instead of nothing. See docs/live-turn-streaming.md. */
  status: 'pending' | 'complete' | 'failed';
  /** Human-readable failure reason for a 'failed' turn; null otherwise. */
  error: string | null;
  /** Persisted media (images, voice notes, docs) so the turn renders its
   *  attachments on load — no bytes, just node/file references. */
  attachments: ConversationAttachment[];
  /** Persisted thought trail (grounded action labels), present on an outbound
   *  row when the brain has trail-persistence on — lets the "Thought process"
   *  record survive a reload. Undefined when not persisted. */
  thoughts?: Array<{ kind: string; label: string; elapsedMs?: number }>;
  /** Deterministic tool-outcome tally for the turn — the runtime's own
   *  ledger, persisted at finalize. Drives the "N tool calls · M failed"
   *  footer so the record is independent of the reply's claims. */
  toolStats?: ToolOutcomeStatsRow;
  /** True when this row belongs to a superseded (replaced) turn pair — the
   *  user cancelled the turn mid-stream and re-sent original + correction as
   *  one combined turn (data.superseded_by). The pair stays in the transcript,
   *  rendered dimmed with a "replaced" tag; prompt history and digests skip it. */
  superseded?: boolean;
  createdAt: string;
};

export type TestApiKeyResult = {
  ok: boolean;
  /** One-line summary for the UI — e.g. '13 models accessible' or
   *  'OpenAI rejected the key (401)'. */
  message: string;
  /** Provider label for the result line. Empty when we can't resolve the
   *  provider from the key's service. */
  provider: string;
  /** Which adapter ran the probe ('openai-tts', 'anthropic-chat', …). */
  adapter: string;
  /** Number of models accessible to this key, if discovery succeeded. */
  modelsFound?: number;
};

export type ComposeStatus = {
  state: ComposeState;
  /** The updater's last refresh outcome verbatim (e.g. 'refreshed',
   *  'modified', 'no-baseline', 'unavailable'), for the details view. */
  refresh: string | null;
  /** The CLIENT stack's compose (v0.200 split). 'absent' state = a
   *  server-only box (no docker-compose.client.yml — nothing to drift). */
  client: { state: ComposeState | 'absent'; refresh: string | null };
  /** The updater sidecar's own script (v0.206+). Before the self-refresh
   *  landed this was the silent failure: a stale script rolled the server
   *  stack, reported ok, and skipped the client stack with no error anywhere.
   *  'unknown' on any box still running that script — it reports no sha. */
  updater: { state: UpdaterScriptState; refresh: string | null };
  /** The front door (v0.232.126+): infra/caddy/Caddyfile is release-owned and
   *  refreshed by the updater like compose. 'unknown' on a box whose updater
   *  predates the field. A 'modified' Caddyfile means release-level front-door
   *  changes are not arriving there; box routes belong in conf.d/. */
  caddy: { state: ComposeState; refresh: string | null };
  checkedAt: string | null;
};

export type UpdateCheck = {
  currentVersion: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  checkedAt: string;
  /** Set when the check itself failed (network, rate limit, no releases yet). */
  error: string | null;
  /** The owner-UI (jackdaw) release stream — versioned separately since the
   *  repo split. `latest` is jackdaw's newest release; `pairedTag` is the
   *  client tag THIS server release was tested with (from the release-pair
   *  file baked into the image). The server cannot know which client build a
   *  browser is running, so "is an interface update available" is computed by
   *  the client itself against its own APP_VERSION. Absent on servers that
   *  predate the field. */
  client?: {
    latest: ReleaseInfo | null;
    pairedTag: string | null;
    error: string | null;
  } | null;
};

export type UpdaterStatus = {
  phase: UpdaterPhase;
  target: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
};

export interface TailnetStatus {
  available: true;
  /** tailscaled backend state: "Running" when connected; "NeedsLogin",
   *  "Stopped", "Starting" otherwise. */
  backendState: string;
  /** This node's MagicDNS name + hostname (how peers reach US). */
  self: { dnsName: string; hostName: string; online: boolean } | null;
  /** The tailnet domain, e.g. "tail1234.ts.net". */
  magicDNSSuffix: string | null;
  peers: TailnetPeer[];
}

export interface TailnetUnavailable {
  available: false;
  /** Human-readable why — shown in the status tile. */
  reason: string;
}

export type TailnetResult = TailnetStatus | TailnetUnavailable;

export type TailscaleConfigSummary = {
  hostname: string;
  masked: string;
  lastActivatedAt: Date | null;
};

export type SystemHealth = {
  ts: string;
  scope: 'container' | 'host';
  host: {
    cpuLoadPct: number | null;
    mem: { usedBytes: number; totalBytes: number; usedPct: number } | null;
    disk: DiskInfo | null;
    uptimeSec: number;
    heapUsedBytes: number;
    rssBytes: number;
    loadAvg: number[];
    cpuCores: number;
  };
  postgres: {
    up: boolean;
    dbSizeBytes: number | null;
    connections: number | null;
    cacheHitPct: number | null;
    topTables: { name: string; bytes: number }[];
  };
  storage: {
    minioUp: boolean | null;
    attachmentBytes: number | null;
    filesDisk: DiskInfo | null;
  };
  /** Tier-2 document parser fallback (.odt / .pptx / .doc / .rtf / .epub /
   *  …) — sibling docker service. `up: false` means the fallback path
   *  degrades cleanly to `no_text_layer` on every new ingest of those
   *  formats; in-process parsers (pdf/docx/xlsx/text) keep working. */
  tika: {
    up: boolean;
    version: string | null;
  };
  /** The browser sidecar (browserless/chromium) — the Pages → PDF export
   *  engine, a sibling docker service like Tika. `up: false` means PDF
   *  downloads 503 until it's back (Markdown/Word unaffected); `up: null`
   *  means BROWSER_WS_ENDPOINT isn't configured (e.g. detached dev). */
  browser: {
    up: boolean | null;
    version: string | null;
  };
  /** The configured embedding server. For the `local` provider this is the
   *  self-hosted Ollama/LM Studio/TEI on MANTLE_LOCAL_EMBEDDING_URL (the
   *  bundled `ollama` compose service in prod). `up: true` means it's
   *  reachable AND the configured model is loaded — the only state in which
   *  ingest can actually embed. `up: null` = a remote/cloud embedder
   *  (openrouter/openai/google), which isn't pingable from here without a key,
   *  so it's surfaced as "remote" rather than a misleading red dot. */
  embedder: {
    up: boolean | null;
    provider: string | null;
    model: string | null;
    detail: string | null;
    /** Where the embedder runs: a self-hosted server ('local') or a cloud
     *  provider ('remote'). Shown on the dashboard pill label. */
    scope: 'remote' | 'local' | null;
  };
  /** CLI sandboxes supervisor (sandboxd) — profile-gated like the tailnet,
   *  so `up: null` (muted pill) is the resting state on a box without the
   *  `sandboxes` compose profile. `up: true` requires sandboxd answering
   *  (its own /healthz additionally verifies docker); counts and the disk
   *  budget come from its live listing. */
  sandboxes: {
    up: boolean | null;
    total: number | null;
    running: number | null;
    disk: { usedBytes: number | null; budgetBytes: number } | null;
  };
  /** Media sidecar (yt-dlp + ffmpeg) — the video_ingest fetch/transcode
   *  engine, profile-gated like sandboxes, so `up: null` (muted pill) is the
   *  resting state on a box without the `media` compose profile. Versions
   *  come from its /healthz — that is what makes a stale or failed yt-dlp
   *  self-update VISIBLE instead of silently breaking downloads. */
  media: {
    up: boolean | null;
    ytDlpVersion: string | null;
    ffmpegVersion: string | null;
    /** null on images built before the CAD tier (v0.232.92) — DWF renders
     *  fall back to embedded thumbnails without it. */
    ezdwfVersion: string | null;
    /** null on images built before the DWG tier (v0.232.99) — with either of
     *  these missing the UI should show "DWG tier missing" (DWG parsing and
     *  rendering both need the sidecar; absence means the whole format). */
    dwg2dxfVersion: string | null;
    ezdxfVersion: string | null;
  };
  /** Tailscale / local network — the optional tailnet that lets a cloud VPS
   *  reach a LAN model box by MagicDNS name. Profile-gated and off by default
   *  in dev, so `up: null` (a muted/disabled pill) is the normal resting state;
   *  `up: true` only when tailscaled reports backendState 'Running'. */
  network: {
    up: boolean | null;
    detail: string | null;
  };
  degraded: string[];
};

export type ProvisionResult = {
  createdWorkers: { kind: string; name: string; provider: string; model: string }[];
  createdAgent: { slug: string; name: string } | null;
  /** Capabilities skipped because the optional key wasn't provided. */
  skipped: string[];
  /** Specialist agents seeded alongside the persona (Pages, Ledger, Remy,
   *  Researcher, Coder) and wired into the assistant's delegate_to. Names of the
   *  ones that seeded successfully; a seed that throws is logged + omitted (it
   *  never aborts onboarding — the persona is what matters). */
  seededSpecialists: string[];
};

export type HeartbeatFireSummary = {
  id: string;
  firedAt: string;
  traceId: string | null;
  disposition: string;
  stateBefore: Record<string, unknown> | null;
  stateAfter: Record<string, unknown> | null;
  replyText: string | null;
  replySurfaceRef: Record<string, unknown> | null;
  errorMessage: string | null;
};

export type AgentTelegramBinding = {
  accountId: string;
  botUsername: string;
  enabled: boolean;
  lastPollAt: string | null;
  lastPollError: string | null;
};

export type AgentTelegramChat = {
  id: string;
  telegramChatId: string;
  label: string;
  status: 'pending' | 'allowed' | 'denied';
  lastMessageAt: string | null;
};

export type DiffStatus =
  /** Live matches the template (for tracked fields). */
  | 'ok'
  /** In the template, absent (or disabled) in the brain — a capability not landed. */
  | 'missing'
  /** In the brain, not in the template — operator-added, informational. */
  | 'extra'
  /** Present in both, but a tracked field diverges. */
  | 'modified';

export type FieldDiff = {
  /** 'toolGroupSlugs' | 'skillSlugs' | 'delegate_to' | 'instructions' |
   *  'toolSlugs' | 'model' | 'systemPrompt' | 'enabled' */
  field: string;
  /** The template value — what an "adopt" would write. */
  manifest: string | string[] | null;
  /** The live value in the brain. */
  live: string | string[] | null;
  /** Set fields only: members in `live` but not `manifest` (operator-added). */
  added?: string[];
  /** Set fields only: members in `manifest` but not `live` (not landed). */
  removed?: string[];
  /** Informational-only diff (e.g. a specialist prompt) — shown, not weighted. */
  info?: boolean;
};

export type EntityDiff = {
  kind: EntityKind;
  /** Agent/skill/group slug, or the worker kind. */
  slug: string;
  name: string;
  status: DiffStatus;
  severity: AuditSeverity;
  /** One-line human summary of the difference. */
  summary: string;
  /** Tracked fields that differ (empty when status is 'ok'). */
  fields: FieldDiff[];
  /** Can the operator "Adopt from template" this item? True for missing/modified
   *  (apply the manifest version); false for ok (nothing to do) and extra
   *  (operator-added — adopting would mean deleting, which we never do). */
  adoptable: boolean;
};

export type ConfigDiffReport = {
  generatedAt: string;
  /** The shipped template version (APP_VERSION). */
  appVersion: string;
  /** The version the brain was last auto-reconciled to (null if never). */
  lastReconciledVersion: string | null;
  entities: EntityDiff[];
  counts: { ok: number; missing: number; extra: number; modified: number };
};

export type AdoptKind = 'persona' | 'agent' | 'skill' | 'tool-group' | 'worker';

// ── Server-lib view/query DTOs (jackdaw split P0 follow-up: @server/* purge) ──
// Moved from server/web/lib/* and @mantle/content; the originals re-export
// these names so server import paths are unchanged.

export type UpdaterPhase =
  'idle' | 'pulling' | 'rolling' | 'done' | 'error' | 'unconfigured' | 'requested';

/** The updater SCRIPT's own currency. Deliberately not `ComposeState`: the
 *  script has no `no-baseline` standoff (it self-adopts, having no supported
 *  box-local variation), so a missing baseline is not a state an operator can
 *  act on — the only actionable state is `modified`. */
export type UpdaterScriptState =
  | 'in-sync' // box script == this release's canonical
  | 'stale' // differs — self-refreshes on the next successful update
  | 'modified' // differs from its baseline: hand-edited, refresh refused
  | 'unknown'; // no stack.json, or a pre-v0.206 updater that reports no sha

export type ComposeState =
  | 'in-sync' // box compose == this release's canonical
  | 'stale' // pristine (== baseline) but not this release's — refresh hasn't run
  | 'modified' // hand-edited canonical file — auto-refresh disabled, needs adoption
  | 'no-baseline' // pre-adoption box — run scripts/compose-adopt.sh once
  | 'unknown'; // no stack.json (old updater.sh / no sidecar / dev)

export type ReleaseInfo = {
  /** Tag as published, e.g. "v0.20.67". */
  tag: string;
  /** Bare version, e.g. "0.20.67". */
  version: string;
  name: string;
  url: string;
  publishedAt: string | null;
};

export type DiskInfo = { usedBytes: number; totalBytes: number; usedPct: number; mount: string };

export type EntityKind = 'persona' | 'agent' | 'skill' | 'tool-group' | 'worker';

export type StudioNodeKind = 'agent' | 'skill' | 'group';

/** One peer on the tailnet (another device sharing your tailnet). */
export interface TailnetPeer {
  /** MagicDNS name, trailing dot stripped — e.g. "gemma-box.tail1234.ts.net".
   *  This is what you'd put in a route base URL: http://<dnsName>:<port>/v1 */
  dnsName: string;
  /** Short hostname — e.g. "gemma-box". */
  hostName: string;
  /** Tailscale IPs (100.x.y.z / fd7a:…). Surfaced for reference; prefer names. */
  ips: string[];
  online: boolean;
  /** OS string tailscaled reports (linux / windows / macOS …), best-effort. */
  os: string | null;
}

export type ToolOutcomeStatsRow = {
  calls: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Confirm-gated calls parked behind operator approval — not yet run. */
  queued: number;
  failures: Array<{ slug: string; error: string }>;
};

// ── Server-lib view/query DTOs (jackdaw split P0 follow-up: @server/* purge) ──
// Moved from server/web/lib/* and @mantle/content; the originals re-export
// these names so server import paths are unchanged.

export type CacheHitStats = {
  hits: number;
  misses: number;
  apiCalls: number;
};

export type DuplicateSuppression = {
  /** Model slug captured in trace_steps.meta.model at suppression time. */
  model: string;
  /** How many duplicate tool_use blocks were suppressed in the window. */
  count: number;
  /** Distinct tool slugs the duplicates targeted (top 5, comma-separated). */
  topSlugs: string;
  /** Most recent suppression, ISO string. */
  lastAt: string;
};

export type FactCostCapStats = {
  /** Extractor model slug captured in trace_steps.meta.model. */
  model: string;
  /** How many process_facts steps dropped facts to the cap in the window. */
  runs: number;
  /** Total facts discarded across those runs (sum of meta.dropped). */
  factsDropped: number;
  /** Most recent occurrence, ISO string. */
  lastAt: string;
};

export type Traffic = {
  count: number;
  errorCount: number;
  avgMs: number | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
};

export type StudioGraph = {
  generatedAt: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  agents: StudioAgentDetail[];
  skills: StudioSkillDetail[];
  toolGroups: StudioToolGroupDetail[];
  workers: StudioWorkerDetail[];
  /** Live config-integrity report (the same checker behind /debug/integrity). */
  report: SystemReport;
};

export type StudioAgentDetail = {
  id: string;
  slug: string;
  name: string;
  model: string;
  role: string;
  enabled: boolean;
  isPersona: boolean;
  skillSlugs: string[];
  /** Skills attached but NOT resolved (missing or disabled) — surfaced honestly. */
  missingSkillSlugs: string[];
  delegateSlugs: string[];
  /** Tool groups granted to this agent. */
  toolGroupSlugs: string[];
  /** Granted groups that are missing or disabled — surfaced honestly. */
  missingToolGroupSlugs: string[];
  toolCount: number;
  params: { temperature?: number; max_tokens?: number };
  maxIterations?: number;
  /** Whether this is a manifest agent that can be reset to its canonical default. */
  resettable: boolean;
  /** The base system prompt (editable prose in Phase 2). */
  systemPrompt: string;
  /** The enabled, attached skills in composition order. */
  skillBlocks: ComposedSkillBlock[];
  /** The full assembled system prompt the model receives (base + skill blocks),
   *  exactly as `composeSystemPromptWithSkills` builds it on a real turn. */
  composedPrompt: string;
};

export type ComposedSkillBlock = { slug: string; name: string; instructions: string };

export type StudioSkillDetail = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  instructions: string;
  /** Fan-out: every agent that attaches this skill (the many-to-many). */
  usedByAgentSlugs: string[];
};

export type StudioToolGroupDetail = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  toolSlugs: string[];
  /** Fan-out: every agent that grants this group. */
  usedByAgentSlugs: string[];
};

export type StudioWorkerDetail = {
  id: string;
  kind: string;
  name: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** Worker prose (registry): the chat-worker system prompt + the vision/document
   *  extraction prompt, when present. */
  systemPrompt: string | null;
  extractionPrompt: string | null;
  issues: string[];
};

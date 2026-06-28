/**
 * Integrity surface — shared types.
 *
 * Two read-only views, no synthetic fixtures:
 *   • Live (`landed.ts`) — observes the *real* content you add (notes, pages,
 *     tasks, events, contacts, secrets, files, email) as it lands in the brain,
 *     and reports its per-type footprint (L6 node · L5 summary/embedding/tsv ·
 *     L4 facts · graph edges · the extractor_run trace). Honest by design: a
 *     secret keeps its sealed body out of the LLM, a scanned image with no
 *     vision worker *correctly* skips — those read neutral, not red.
 *   • Corpus audit (`audit.ts`) — scans the *existing* corpus for invariant
 *     violations (no writes, no cost).
 *
 * See docs/data-flow-tracing.md (the signature table) and docs/journey.md
 * (the action→layer map) for the behaviour these footprints encode.
 */

export type CheckStatus = 'pass' | 'fail' | 'info';

export type CheckResult = {
  /** Short column-ish label: "Trace", "L5 summary", "Emb 768", … */
  label: string;
  status: CheckStatus;
  /** Actual-vs-expected detail, shown on hover / in the expanded row. */
  detail?: string;
};

/** The structural footprint of one node, read straight from the brain tables. */
export type ProbeFootprint = {
  nodeId: string;
  exists: boolean;
  nodeType: string | null;
  summary: string | null;
  embDims: number | null;
  hasTsv: boolean;
  nFacts: number;
  factKinds: string[];
  /** mentioned_in edges (entity → node). */
  nEntities: number;
  /** Duplicate mentioned_in edges (same entity → node twice) — must be 0 if the
   *  extractor rebuilds idempotently rather than appending on re-extract. */
  dupMentionEdges: number;
  /** content_chunks rows for this node. */
  nChunks: number;
  run: {
    traceId: string;
    startedAt: string;
    status: string;
    disposition: string | null;
    stepNames: string[];
    costMicroUsd: number;
  } | null;
};

/** One optional service/worker's readiness. */
export type Capability = { available: boolean; detail: string };

/** Brain-readiness snapshot. */
export type Capabilities = {
  tika: Capability;
  vision: Capability;
  extractor: Capability;
  embedding: Capability;
  summarizer: Capability;
  reflector: Capability;
  stt: Capability;
};

// ─── live landed view ───────────────────────────────────────────────────────

export type LandedState =
  /** Inserted, extractor hasn't terminated yet — transient; flips on node_indexed. */
  | 'indexing'
  /** Success + the expected layers landed (summary · 768-dim embedding · tsv). */
  | 'ok'
  /** Correctly skipped (e.g. a scanned image with no vision worker) — shows why. */
  | 'skipped'
  /** Success but a layer is missing (silent-miss / dim drift / duplicate edges). */
  | 'fail'
  /** No extractor_run after the stall window — is apps/agent + an extractor up? */
  | 'stalled';

export type LandedItem = {
  nodeId: string;
  nodeType: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  footprint: ProbeFootprint;
  state: LandedState;
  checks: CheckResult[];
};

export type LandedReport = {
  generatedAt: string;
  items: LandedItem[];
  capabilities: Capabilities;
};

// ─── passive corpus audit ───────────────────────────────────────────────────
//
// The read-only health scan of the *existing* brain for invariant violations
// (no writes, no fixtures, no cost): "is what's already stored consistent?".

export type AuditSeverity = 'high' | 'medium' | 'low';

/** One offending row, with enough to drill in. */
export type AuditSample = { id: string; kind: string; detail: string };

export type AuditCheck = {
  key: string;
  label: string;
  severity: AuditSeverity;
  /** One-line explanation of the invariant + why a violation matters. */
  note: string;
  count: number;
  /** True if the violation count hit the query cap (so `count` is a floor). */
  capped: boolean;
  ok: boolean;
  samples: AuditSample[];
  /** Age span (oldest/newest, `YYYY-MM-DD`) of the offending rows — uncapped,
   *  so it reflects the true range even when `count` is floored. Lets the UI
   *  tell pre-fix *sediment* (all old) apart from a *live* regression (recent).
   *  null when the check has no natural timestamp or zero violations. */
  oldestAt: string | null;
  newestAt: string | null;
};

export type AuditReport = {
  generatedAt: string;
  checks: AuditCheck[];
  totalViolations: number;
};

// ─── system config integrity ────────────────────────────────────────────────
//
// Read-only check of the agent/skill/tool/worker CONFIG graph against the
// declarative manifest (apps/web/lib/system-manifest). Catches the silent-drop
// cases the runtime resolvers hide: an agent referencing a skill/tool that has
// no row, a specialist not wired into the persona's delegate_to, a default
// worker missing for a kind. Same severity vocabulary as the corpus audit.

export type SystemSample = { id: string; detail: string };

export type SystemCheck = {
  key: string;
  label: string;
  severity: AuditSeverity;
  ok: boolean;
  /** Human-readable state — what's right, or what's broken + why it matters. */
  detail: string;
  /** Offending specifics (dangling slugs, unlinked skills, missing agents). */
  samples?: SystemSample[];
};

export type SystemReport = {
  generatedAt: string;
  checks: SystemCheck[];
  /** Number of checks that are not ok. */
  problems: number;
};

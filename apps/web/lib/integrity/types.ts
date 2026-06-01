/**
 * Integrity-probe harness — shared types.
 *
 * The harness inserts one synthetic fixture per content node type, waits for
 * the extractor to settle, and asserts the *expected* per-type footprint
 * against what actually landed in the brain (L6 node · L5 summary/embedding/
 * tsv · L4 facts · graph edges · the extractor_run trace).
 *
 * The keystone is the **expectation matrix** (`spec.ts`): integrity is not
 * "every layer must light up" — a secret deliberately keeps its sealed body
 * out of the LLM, a scanned PDF *correctly* skips with `no_text_layer`. Green
 * means "matched the expectation for this type", including expected skips.
 *
 * See docs/data-flow-tracing.md (the signature table) and docs/journey.md
 * (the action→layer map) for the behaviour these expectations encode.
 */

/** A layer either must be there, must NOT be there, or is reported-not-asserted. */
export type LayerRule = 'present' | 'absent' | 'optional';

/** The terminal extractor_run we expect for a fixture. */
export type TraceExpectation =
  | { status: 'success' }
  | { status: 'skipped'; disposition: string }
  /** success OR a named skip are both acceptable (config-dependent types like
   *  task/event whose facts only land if allow-listed in the worker config). */
  | { status: 'either'; skipDisposition?: string };

export type FixtureExpectation = {
  trace: TraceExpectation;
  /** L5 `data.summary` non-empty (watch the empty-string trap). */
  summary: LayerRule;
  /** L5 `embedding` present. When present, dims are separately asserted == 768. */
  embedding: LayerRule;
  /** L5 `search_tsv` populated. */
  tsv: LayerRule;
  /** L4 — at least one fact with `source_node_id` = this node. */
  facts: LayerRule;
  /** Graph — at least one `mentioned_in` edge (entity → node). */
  graph: LayerRule;
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
    /** Trace id + start — used to detect a *new* run after an update. */
    traceId: string;
    startedAt: string;
    status: string;
    disposition: string | null;
    stepNames: string[];
    costMicroUsd: number;
  } | null;
};

/** A fact's identity + kind — captured before a delete to verify the kind-aware
 *  reaper (0059): episodic/factual die, semantic/preference are kept sourceless. */
export type FactRef = { id: string; kind: string };

export type CheckStatus = 'pass' | 'fail' | 'info';

export type CheckResult = {
  /** Short column-ish label: "Trace", "L6", "L5 summary", "Emb 768", … */
  label: string;
  status: CheckStatus;
  /** Actual-vs-expected detail, shown on hover / in the expanded row. */
  detail?: string;
};

export type FixtureState = 'ok' | 'fail' | 'stalled' | 'missing' | 'error';

export type FixtureResult = {
  key: string;
  label: string;
  nodeType: string;
  state: FixtureState;
  nodeId: string | null;
  footprint: ProbeFootprint | null;
  checks: CheckResult[];
  /** Re-extraction-after-edit checks (only when the update sub-test ran). */
  updateChecks?: CheckResult[];
  /** Kind-aware cleanup checks (only when the delete sub-test ran). */
  deleteChecks?: CheckResult[];
  /** True once the delete sub-test removed the node. */
  deleted?: boolean;
  costMicroUsd: number;
  durationMs: number;
  error?: string;
};

export type SuiteReport = {
  runId: string;
  runTag: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalCostMicroUsd: number;
  passed: number;
  total: number;
  results: FixtureResult[];
};

/** Tag applied to every probe node, ever — the broad cleanup key. */
export const PROBE_BASE_TAG = 'integrity-probe';
/** Per-run tag: `integrity-probe-<8hex>` (kept ≤ 40 chars for `dedupeTags`). */
export const probeRunTag = (runId: string) => `${PROBE_BASE_TAG}-${runId}`;

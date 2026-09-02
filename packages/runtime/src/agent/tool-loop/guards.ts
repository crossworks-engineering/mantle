/**
 * Tool loop: the per-turn guard state and the decisions it makes about one
 * tool call. Pure (no I/O), so every rule is unit-tested in guards.test.ts.
 * Lifted out of runToolLoop on 2026-09-02 (audit, complexity C1) with the
 * decision ORDER preserved exactly — see the numbered checks in `preParse`
 * and `postParse` — because the order is the contract the tests pin.
 *
 * ── Tool-volume guards (structural backstop against tool-spam runaways) ──
 * A misbehaving model (notably Grok-4.x fixating on one tool) can emit
 * hundreds of tool calls, ballooning context + cost — one prod turn fired
 * page_unshare 1599× and burned $0.73 before crashing. max_iters caps
 * ROUNDS, not calls-per-round, and the in-response dedup only catches
 * byte-identical repeats, so volume needs its own caps.
 *
 * Enforcement is at BATCH boundaries: a response that STARTS under its caps
 * executes in full (bounded by MAX_TOOL_CALLS_PER_RESPONSE). Cutting a batch
 * halfway severed a coherent write batch once — 10 page_block_deletes cut at
 * 1-of-10 left a production SOP draft half-edited (2026-07-06) — and a
 * bounded overshoot is strictly better than a half-applied edit. A batch
 * that starts AT/OVER a cap is skipped call-by-call with guidance.
 *
 * The turn/per-tool caps are per-agent overridable via memory_config
 * (`max_tool_calls` / `max_calls_per_tool`) — heavy editors like the pages
 * agent legitimately need more than chat agents; hard ceilings still bound
 * the blast radius.
 *
 * ── Failure-aware guards (outcome-sensitive complements to the caps) ──
 * The volume caps count calls regardless of what they produced, so a flail
 * loop — the model re-issuing one broken call verbatim, or re-reading state
 * that never changes — burns up to 15 calls before the fixation cap ends it.
 * These two watch OUTCOMES per canonical signature (slug + post-repair args
 * with sorted keys) and step in far earlier. The error payload starts
 * teaching at the 2nd identical failure; at the limit the call is skipped,
 * not dispatched.
 */
import { createHash } from 'node:crypto';

export const MAX_TOOL_CALLS_PER_RESPONSE = 20; // calls beyond this in ONE response are dropped
export const MAX_TOOL_CALLS_PER_TURN = 40; // default cumulative budget across rounds → then force a final answer
export const MAX_CALLS_PER_TOOL_PER_TURN = 15; // default same-tool fixation breaker (counts even when args vary)
export const HARD_MAX_TOOL_CALLS_PER_TURN = 200; // ceiling for per-agent overrides
export const HARD_MAX_CALLS_PER_TOOL_PER_TURN = 100; // ceiling for per-agent overrides
export const REPEATED_FAILURE_LIMIT = 5; // identical call failed N times → further attempts blocked
export const NO_PROGRESS_LIMIT = 5; // identical call returned the identical result N times → blocked

/** Resolve a per-agent cap override: positive ints only, floored, clamped to
 *  the hard ceiling; anything else falls back to the flat default. */
export function resolveCap(
  requested: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1)
    return fallback;
  return Math.min(ceiling, Math.floor(requested));
}

/** Cheap stable digest of a serialized tool result, for the no-progress
 *  guard's identical-result comparison. Keeping full payloads per signature
 *  would hold every large read in memory for the whole turn. */
export function hashToolResult(serialized: string): string {
  return createHash('sha256').update(serialized).digest('base64').slice(0, 16);
}

/** Deterministic JSON encoding (recursively sorted object keys) so the
 *  failure-aware guards see `{"a":1,"b":2}` and `{"b":2,"a":1}` — and a
 *  post-repair `25` vs the model's `"25"` — as the same call. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
}

export type SkipReason =
  | 'duplicate_in_response'
  | 'too_many_calls_in_response'
  | 'turn_tool_budget_reached'
  | 'tool_repeat_limit'
  | 'repeated_failure'
  | 'no_progress';

/** Why a call must NOT run, plus the note the model is told. `firstCallId`
 *  only accompanies a duplicate (the model is pointed at the call that did
 *  run). */
export type GuardVerdict = { reason: SkipReason; note: string; firstCallId?: string };

export class TurnGuards {
  readonly maxToolCallsPerTurn: number;
  readonly maxCallsPerToolPerTurn: number;
  totalToolCalls = 0;
  budgetExhausted = false;
  private readonly perToolCounts = new Map<string, number>();
  private readonly exactFailureCounts = new Map<string, number>();
  private readonly identicalResults = new Map<string, { hash: string; count: number }>();
  // Per-batch (one model response) state, reset by beginBatch().
  private seenSignatures = new Map<string, string>(); // raw signature → first call.id
  private responseCallIndex = 0; // non-duplicate calls seen THIS response
  private perToolCountsAtBatchStart = new Map<string, number>();
  dispatchedThisBatch = 0;

  constructor(caps: { maxToolCallsPerTurn: number; maxCallsPerToolPerTurn: number }) {
    this.maxToolCallsPerTurn = caps.maxToolCallsPerTurn;
    this.maxCallsPerToolPerTurn = caps.maxCallsPerToolPerTurn;
  }

  /** Snapshot the per-tool counters: cap decisions inside this response
   *  compare against the snapshot, so a batch that begins under a cap
   *  executes in full instead of being severed halfway. */
  beginBatch(): void {
    this.seenSignatures = new Map();
    this.responseCallIndex = 0;
    this.perToolCountsAtBatchStart = new Map(this.perToolCounts);
    this.dispatchedThisBatch = 0;
  }

  /** Checks that need only the raw call (evaluated BEFORE args parsing):
   *  1. in-response duplicate (byte-identical name + args),
   *  2. per-response volume cap (non-duplicate calls only),
   *  3. a budget that tripped between batches (defensive),
   *  4. same-tool fixation, against the batch-start snapshot. */
  preParse(call: { id: string; slug: string; argsRaw: string }): GuardVerdict | null {
    const { id, slug, argsRaw } = call;
    const signature = `${slug}::${argsRaw}`;
    const firstCallId = this.seenSignatures.get(signature);
    if (firstCallId !== undefined) {
      return {
        reason: 'duplicate_in_response',
        firstCallId,
        note:
          `This exact tool call (same name + same arguments) appeared more ` +
          `than once in your response. Only the first was dispatched ` +
          `(call_id ${firstCallId}); this duplicate was suppressed to ` +
          `prevent accidental write amplification. If you intended a ` +
          `single operation, the first call's result stands. If you ` +
          `intended distinct operations, re-issue with different arguments.`,
      };
    }
    this.seenSignatures.set(signature, id);
    this.responseCallIndex += 1;
    if (this.responseCallIndex > MAX_TOOL_CALLS_PER_RESPONSE) {
      return {
        reason: 'too_many_calls_in_response',
        note:
          `You issued more than ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls in one ` +
          `response; the rest were not run. Issue fewer, more deliberate calls.`,
      };
    }
    if (this.budgetExhausted) {
      return {
        reason: 'turn_tool_budget_reached',
        note:
          `This turn reached its tool-call budget (${this.maxToolCallsPerTurn}). ` +
          `Stop calling tools and answer with what you already have.`,
      };
    }
    const priorAtBatchStart = this.perToolCountsAtBatchStart.get(slug) ?? 0;
    if (priorAtBatchStart >= this.maxCallsPerToolPerTurn) {
      return {
        reason: 'tool_repeat_limit',
        note:
          `You've called '${slug}' ${this.perToolCounts.get(slug) ?? priorAtBatchStart} times this turn ` +
          `(limit ${this.maxCallsPerToolPerTurn}); further '${slug}' calls are blocked. ` +
          `If you were partway through a multi-item job, stop NOW and report exactly ` +
          `what completed and what remains, so your caller can continue it — a bulk/batch ` +
          `variant of this tool, if one exists, does the whole job in one call next time. ` +
          `Do NOT improvise with a different tool to force the same change through.`,
      };
    }
    return null;
  }

  /** Outcome-sensitive checks on the CANONICAL signature (post-repair args,
   *  sorted keys): 5. repeated identical failure, 6. no progress. */
  postParse(slug: string, guardSig: string): GuardVerdict | null {
    const priorExactFailures = this.exactFailureCounts.get(guardSig) ?? 0;
    if (priorExactFailures >= REPEATED_FAILURE_LIMIT) {
      return {
        reason: 'repeated_failure',
        note:
          `This exact call ('${slug}' with these same arguments) has already failed ` +
          `${priorExactFailures} times this turn; it was blocked, not re-run — repeating it ` +
          `verbatim cannot succeed. Change the arguments or the approach, or answer with ` +
          `what you have.`,
      };
    }
    const priorIdentical = this.identicalResults.get(guardSig);
    if (priorIdentical && priorIdentical.count >= NO_PROGRESS_LIMIT) {
      return {
        reason: 'no_progress',
        note:
          `You've made this exact call ('${slug}' with these same arguments) ` +
          `${priorIdentical.count} times and received the identical result every time — the ` +
          `state isn't changing, so it was blocked, not re-run. Use the result already in ` +
          `context above; if you need different data, change the arguments.`,
      };
    }
    return null;
  }

  /** The call passed every guard and will be dispatched. */
  admit(slug: string): void {
    this.perToolCounts.set(slug, (this.perToolCounts.get(slug) ?? 0) + 1);
    this.totalToolCalls += 1;
    this.dispatchedThisBatch += 1;
  }

  /** An identical failing call escalates: returns the new failure count for
   *  this signature (the payload teaches from 2, the guard blocks at the limit). */
  recordFailure(guardSig: string): number {
    const failures = (this.exactFailureCounts.get(guardSig) ?? 0) + 1;
    this.exactFailureCounts.set(guardSig, failures);
    return failures;
  }

  /** No-progress accounting: consecutive identical results for the same
   *  signature. A different result resets the streak — re-reads after writes
   *  legitimately repeat and are never penalised. */
  recordResult(guardSig: string, serialized: string): void {
    const resultHash = hashToolResult(serialized);
    const prior = this.identicalResults.get(guardSig);
    this.identicalResults.set(
      guardSig,
      prior && prior.hash === resultHash
        ? { hash: resultHash, count: prior.count + 1 }
        : { hash: resultHash, count: 1 },
    );
  }

  /** Batch-boundary decisions, in order: a sizeable batch whose calls were
   *  ALL guard-skipped did zero work (a model mass re-emitting into a wall it
   *  was just told about is flailing, not adapting — the ≥3 floor leaves room
   *  for genuine adaptation after a single skipped call); then the per-turn
   *  budget, checked here and never mid-batch. */
  endBatch(callsInBatch: number): 'batch_fully_skipped' | 'budget_exhausted' | null {
    if (callsInBatch >= 3 && this.dispatchedThisBatch === 0) return 'batch_fully_skipped';
    if (this.totalToolCalls >= this.maxToolCallsPerTurn) this.budgetExhausted = true;
    return this.budgetExhausted ? 'budget_exhausted' : null;
  }
}

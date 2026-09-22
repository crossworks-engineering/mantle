/**
 * `decide()` — the ONE door to the `decider` worker (a typed-decision model,
 * TypeSafe Jev via OpenRouter). Every decision point in Mantle calls this and
 * nothing else, so the rules live in one place:
 *
 *   1. Optional. No decider worker, worker disabled, the use switched off, no
 *      key, adapter missing, HTTP error, timeout, malformed answer → `null`.
 *      The caller then runs the path it always ran. A decision sits IN FRONT
 *      of work the caller does anyway; it must never block or break it.
 *   2. Switched per use. `params.uses[use]` carries `enabled` + `mode`
 *      (`shadow`: the answer lands in the trace, behaviour unchanged; `live`:
 *      the caller may act on it). The caller reads `mode` off the outcome and
 *      MUST honour it — `decide()` cannot enforce what the caller does.
 *   3. Bounded. A hard timeout (default 1.5 s); a slow decision is worse than
 *      none. One request, questions answered in parallel by the model.
 *   4. Traced. One `llm_call` step per call with `meta.use`, `meta.mode`, the
 *      model, token + cost rollups (`recordChatUsage`, same keys as every
 *      other LLM step so /debug spend-by-model needs no special case) and a
 *      compact `meta.answers` summary. A shadow week is read from these.
 *   5. Cached in-process on (use, model, state, questions) so a repeated
 *      question costs nothing.
 *
 * Rules for call sites (from the spikes, docs/decisions.md): Jev ranks, groups
 * and flags; CODE applies dates, `superseded_by` and thresholds; Jev alone
 * never retires, merges or overwrites data.
 */
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import {
  bumpWorkerUsage,
  getDefaultWorker,
  type AiWorker,
  type DeciderParams,
  type DecisionUse,
  type DecisionUseConfig,
} from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { recordChatUsage, step } from '@mantle/tracing';
import {
  getDecisionAdapter,
  type DecisionAnswer,
  type DecisionDispatcher,
  type DecisionQuestion,
} from '@mantle/voice';
import { DecisionCache } from './cache';

export const DEFAULTS = {
  timeoutMs: 1_500,
  deferBelow: 0.6,
  actAloneAt: 0.9,
} as const;

export type DecisionMode = 'shadow' | 'live';

/** A use's effective switch, with the worker-level floors folded in. */
export type ResolvedUse = {
  enabled: boolean;
  mode: DecisionMode;
  threshold: number | undefined;
  /** Below this the caller records but does not act (worker `defer_below`,
   *  or the use's own `min_confidence`). */
  deferBelow: number;
  /** At or above this the caller may act with no second check. */
  actAloneAt: number;
};

/** Pure: read one use's switch off the worker params. Missing = OFF; an
 *  enabled use with no mode = `shadow` (the safe default for a new use). */
export function resolveUse(
  params: DeciderParams | null | undefined,
  use: DecisionUse,
): ResolvedUse {
  const cfg: DecisionUseConfig = params?.uses?.[use] ?? {};
  const deferBelow = clamp01(cfg.min_confidence ?? params?.defer_below ?? DEFAULTS.deferBelow);
  const actAloneAt = clamp01(params?.act_alone_at ?? DEFAULTS.actAloneAt);
  return {
    enabled: cfg.enabled === true,
    mode: cfg.mode === 'live' ? 'live' : 'shadow',
    threshold: typeof cfg.threshold === 'number' ? cfg.threshold : undefined,
    deferBelow,
    actAloneAt: Math.max(actAloneAt, deferBelow),
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export type DecideInput = {
  ownerId: string;
  use: DecisionUse;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  /** Optional extra trace meta derived from the answers (e.g. how many
   *  passages a threshold would drop) — lands on the same step. */
  summarize?: (answers: Record<string, DecisionAnswer>) => Record<string, unknown>;
};

export type DecideOutcome = {
  answers: Record<string, DecisionAnswer>;
  mode: DecisionMode;
  use: ResolvedUse;
  model: string;
  cached: boolean;
  ms: number;
};

// ─── Worker resolution (cached per owner) ───────────────────────────────────

type Resolved = {
  worker: AiWorker;
  params: DeciderParams;
  adapter: DecisionDispatcher;
  apiKey: string;
} | null;

const RESOLVE_TTL_MS = 30_000;
const resolved = new Map<string, { at: number; value: Resolved }>();

/** Find the owner's decider worker + adapter + key. Negative results are
 *  cached too (30 s) so a brain without the worker pays one query per half
 *  minute, not one per search. A newly enabled worker is picked up within
 *  that window. */
export async function resolveDecider(ownerId: string): Promise<Resolved> {
  const hit = resolved.get(ownerId);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  let value: Resolved = null;
  try {
    const worker = await getDefaultWorker(ownerId, 'decider');
    if (worker) {
      const adapter = getDecisionAdapter(worker.provider);
      const apiKey =
        (worker.apiKeyId ? await getApiKeyById(worker.apiKeyId) : null) ??
        (await getApiKey(ownerId, worker.provider));
      if (adapter && apiKey) {
        value = { worker, params: (worker.params ?? {}) as DeciderParams, adapter, apiKey };
      }
    }
  } catch (err) {
    console.warn(`[decisions] resolve failed for owner ${ownerId}: ${errorMessage(err)}`);
    value = null;
  }
  resolved.set(ownerId, { at: Date.now(), value });
  return value;
}

/** Test seam + the "owner just toggled it" escape hatch. */
export function forgetResolvedDecider(ownerId?: string): void {
  if (ownerId) resolved.delete(ownerId);
  else resolved.clear();
}

/** Cheap pre-check for callers that want to size a candidate pool before
 *  paying for it (e.g. fetch more passages only when scoring is on). */
export async function decisionUseEnabled(
  ownerId: string,
  use: DecisionUse,
): Promise<ResolvedUse | null> {
  const r = await resolveDecider(ownerId);
  if (!r) return null;
  const u = resolveUse(r.params, use);
  return u.enabled ? u : null;
}

// ─── The call ───────────────────────────────────────────────────────────────

const cache = new DecisionCache<{ answers: Record<string, DecisionAnswer>; model: string }>();

/** Test seam. */
export function clearDecisionCache(): void {
  cache.clear();
}

export async function decide(input: DecideInput): Promise<DecideOutcome | null> {
  const r = await resolveDecider(input.ownerId);
  if (!r) return null;
  const use = resolveUse(r.params, input.use);
  if (!use.enabled) return null;
  const { worker, params, adapter, apiKey } = r;

  const key = DecisionCache.key([input.use, worker.model, input.state, input.questions]);
  const hit = cache.get(key);
  if (hit) {
    return { answers: hit.answers, mode: use.mode, use, model: hit.model, cached: true, ms: 0 };
  }

  const t0 = Date.now();
  return step(
    {
      name: `decide_${input.use}`,
      kind: 'llm_call',
      input: {
        use: input.use,
        mode: use.mode,
        model: worker.model,
        provider: worker.provider,
        questions: Object.keys(input.questions).length,
      },
    },
    async (h) => {
      try {
        const res = await adapter.decide({
          apiKey,
          model: worker.model,
          state: input.state,
          questions: input.questions,
          zeroDataRetention: params.zdr !== false,
          timeoutMs: params.timeout_ms ?? DEFAULTS.timeoutMs,
        });
        const ms = Date.now() - t0;
        recordChatUsage(h, res, worker.model);
        h.setMeta({
          use: input.use,
          mode: use.mode,
          decision_ms: ms,
          answers: summarizeAnswers(res.answers),
          ...(input.summarize ? input.summarize(res.answers) : {}),
        });
        h.setOutput({ answered: Object.keys(res.answers).length, ms });
        cache.set(key, { answers: res.answers, model: res.model });
        void bumpWorkerUsage(worker.id).catch(() => {});
        return { answers: res.answers, mode: use.mode, use, model: res.model, cached: false, ms };
      } catch (err) {
        // "No decision" — never an error for the caller. The step stays
        // visible (amber) so a dead alpha endpoint shows up in /traces.
        h.setMeta({
          use: input.use,
          mode: use.mode,
          model: worker.model,
          failed: errorMessage(err),
        });
        h.setSkipped('decision_failed');
        return null;
      }
    },
  );
}

/** Compact per-question summary for the trace: what was picked and how sure.
 *  Full probability maps stay out (a 20-passage request would be 20 maps). */
export function summarizeAnswers(
  answers: Record<string, DecisionAnswer>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, a] of Object.entries(answers)) {
    if (a.type === 'noul') out[k] = round2(a.probability);
    else if (a.type === 'choice') out[k] = `${a.choice}@${round2(a.confidence)}`;
    else out[k] = `${round2(a.score)}@${round2(a.confidence)}`;
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

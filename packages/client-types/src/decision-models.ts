/**
 * Decision model profiles: what we measured about each OpenRouter decision
 * model, beside what the live catalog already says (context size, input
 * types, price). The catalog cannot say whether a model takes Mantle's
 * request at all, at what privacy level, or how it bills, so this table does.
 *
 * Source: the 2026-10-30 probe of all 28 models (one model at a time; a small
 * request, then one full-size request of 25 passages, about 19,000 tokens,
 * under the 1.5 s worker limit). One full-size timing per model, so `slow`
 * and `fails_full_size` are a first read, not a verdict. A model that is not
 * here is untested: it may run, and nothing claims it works.
 *
 * Today this feeds the pool's refusal (`decisionModelRefusal`, read by
 * `poolModelIssue`) and the decider pool's re-curation. The request planner
 * and the worker screen read it later.
 */

export type DecisionModelStatus =
  /** Full-size request answered under 1.5 s with `zdr`. */
  | 'works'
  /** Answers only with privacy `no_training`: `zdr` returns 404. */
  | 'no_training_only'
  /** Answers, but a full-size request took 1.7 to 5.7 s. */
  | 'slow'
  /** A full-size request failed: a timeout, a 16-question limit, a
   *  16,384-token limit or a byte limit. Smaller requests may pass. */
  | 'fails_full_size'
  /** Cannot take Mantle's request: another state shape or no live endpoint.
   *  The decider pool refuses it. */
  | 'refused';

export type DecisionModelProfile = {
  /** The OpenRouter id, lower case. */
  id: string;
  status: DecisionModelStatus;
  /** The strictest privacy level its OpenRouter route accepts. */
  privacy: 'zdr' | 'no_training';
  /** Bills the state once per question: one search billed about 450,000
   *  tokens. */
  perQuestionBilling?: true;
  /** Reported exactly this many input tokens for a larger request: a
   *  suspected silent cut. Unsafe until checked. */
  suspectedCutAt?: number;
  /** A start value for passage scoring's threshold where Jev's 1.5 drops
   *  right passages. Tune it with eval:route. */
  thresholdStart?: number;
  note?: string;
};

const REFUSED =
  "cannot take Mantle's decision request (another state shape, or no live endpoint; probe 2026-10-30)";

export const DECISION_MODEL_PROFILES: readonly DecisionModelProfile[] = [
  // Group A: work today, under 1.5 s.
  { id: '~typesafe/jev-latest', status: 'works', privacy: 'zdr', note: 'the shipped default' },
  { id: 'typesafe/jev-1.14', status: 'works', privacy: 'zdr' },
  { id: 'typesafe/jev-1.13', status: 'works', privacy: 'zdr' },
  {
    id: 'perplexity/pplx-decider-v1.2',
    status: 'works',
    privacy: 'zdr',
    note: 'tied Jev on quality at about half the cost; slower (median 643 ms)',
  },
  {
    id: 'microsoft/microsoft-decision-1',
    status: 'works',
    privacy: 'zdr',
    note: 'tied Jev on quality; built on Qwen3.5-9B',
  },
  { id: 'nace-ai/drex-v1.5', status: 'works', privacy: 'zdr' },
  {
    id: 'cloudflare/clef-omni',
    status: 'works',
    privacy: 'zdr',
    note: 'ranked passages worse than search alone; do not use',
  },
  // Group B: blocked only by zdr.
  {
    id: 'openai/gpt-6-luna-decisions',
    status: 'no_training_only',
    privacy: 'no_training',
    thresholdStart: 1.0,
    note: 'no zero-retention route on OpenRouter; scored some right passages near 0',
  },
  {
    id: 'respan/span-02',
    status: 'no_training_only',
    privacy: 'no_training',
    perQuestionBilling: true,
    note: 'also 1.6 s on a full-size request',
  },
  // Group C: work, but too slow for 1.5 s.
  { id: 'liquid/d1', status: 'slow', privacy: 'zdr' },
  { id: 'liquid/d1.1', status: 'slow', privacy: 'zdr' },
  { id: 'liquid/d1-ultra', status: 'slow', privacy: 'zdr' },
  { id: 'inception/mercury-decide', status: 'slow', privacy: 'zdr' },
  { id: 'cloudflare/clef', status: 'slow', privacy: 'zdr' },
  { id: 'cloudflare/clef-flash', status: 'slow', privacy: 'zdr', suspectedCutAt: 16_384 },
  {
    id: 'perplexity/pplx-decider-flash-v1.2',
    status: 'slow',
    privacy: 'zdr',
    perQuestionBilling: true,
  },
  { id: 'upstage/solar-decide-flash', status: 'slow', privacy: 'zdr', perQuestionBilling: true },
  { id: 'jaredpalmer/kev-4b', status: 'slow', privacy: 'zdr' },
  // Group D: fail on a full-size request.
  { id: 'upstage/solar-decide', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'nace-ai/drex-v2.0', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'nace-ai/drex-max', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'baseten/joey-1', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'baseten/elephant-1', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'baseten/mammoth-1', status: 'fails_full_size', privacy: 'zdr' },
  { id: 'togethercomputer/tev1-4b-experimental', status: 'fails_full_size', privacy: 'zdr' },
  // Group E: cannot take our request at all.
  { id: 'scaledown/classify-1', status: 'refused', privacy: 'zdr', note: REFUSED },
  { id: 'respan/span-01', status: 'refused', privacy: 'zdr', note: REFUSED },
  { id: 'respan/span-01-lite', status: 'refused', privacy: 'zdr', note: REFUSED },
  { id: 'cloudflare/clairic', status: 'refused', privacy: 'zdr', note: REFUSED },
];

const BY_ID = new Map(DECISION_MODEL_PROFILES.map((p) => [p.id, p]));

/** The profile of a decision model id, or null when it is untested. A
 *  variant suffix (`:free`) is the same model, so it shares the profile. */
export function decisionModelProfile(
  model: string | null | undefined,
): DecisionModelProfile | null {
  if (!model) return null;
  const id = model
    .trim()
    .toLowerCase()
    .replace(/:[a-z0-9_-]+$/, '');
  return BY_ID.get(id) ?? null;
}

/** Why the decider pool refuses this model, or null when it does not. */
export function decisionModelRefusal(model: string | null | undefined): string | null {
  const p = decisionModelProfile(model);
  if (p?.status !== 'refused') return null;
  return (
    `this model ${p.note ?? REFUSED}. ` +
    'Pick a tested decision model such as ~typesafe/jev-latest or perplexity/pplx-decider-v1.2.'
  );
}

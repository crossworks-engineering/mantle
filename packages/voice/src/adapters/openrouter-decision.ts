/**
 * OpenRouter decision adapter — TypeSafe Jev through OpenRouter's
 * `POST /api/alpha/decisions` endpoint (NOT chat completions).
 *
 * Jev is a typed-decision model: state + questions in, `choice` / `score` /
 * `noul` answers with probabilities out, no prose, ~300 ms. The endpoint is
 * marked ALPHA by OpenRouter (2026-09), so this adapter is deliberately thin
 * and defensive: it maps the wire shape onto {@link DecisionResult} and throws
 * on anything else. The `decide()` helper in @mantle/decisions turns every
 * throw into "no decision" so a call site continues on its own path — an alpha
 * endpoint going away must never break a search or a turn.
 *
 * Privacy: every call carries a `provider` block (`decisionProviderPrefs`,
 * the one mapping): `zdr` sends `{ zdr: true, data_collection: 'deny' }`,
 * `no_training` sends `{ data_collection: 'deny' }`. OpenRouter honours both
 * on this endpoint (verified 2026-09-21 and 2026-10-30). A model with no
 * zero-retention route answers 404 under `zdr`; the adapter says so and never
 * retries with less. Raw fetch, same auth + attribution headers as the other
 * OpenRouter adapters so OR's dashboard sees one fingerprint.
 */

import type {
  DecisionAnswer,
  DecisionDispatcher,
  DecisionOptions,
  DecisionPrivacy,
  DecisionResult,
} from './types';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';
import { providerFetch } from './provider-fetch';
import { PROVIDER_TIMEOUTS, ProviderHttpError } from '@mantle/std';

/** `${OPENROUTER_BASE_URL}` is `…/api/v1`; decisions live one level up. */
const DECISIONS_URL = OPENROUTER_BASE_URL.replace(/\/v1\/?$/, '') + '/alpha/decisions';

const DEFAULT_TIMEOUT_MS = PROVIDER_TIMEOUTS.decision;

type WireAnswer =
  | { type: 'noul'; noul?: number }
  | { type: 'choice'; choice?: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'score'; score?: number; confidence?: number; probabilities?: Record<string, number> };

type WireResponse = {
  id?: string;
  model?: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  error?: { code?: number; message?: string };
};

// The requests of one passage-scoring fan-out are sent together, and the
// endpoint answers them side by side (4 requests: 0.7 s). Node 26's built-in
// fetch sent them one after another (4 requests: 2.1 s, 8: 4.2 s; measured
// 2026-10-04), so they go through the shared provider pool (provider-fetch.ts).

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://mantle-ai.tech',
    'X-Title': 'Mantle',
    'Content-Type': 'application/json',
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Wire answer → normalised answer, or null when the shape is not one we
 *  know (the caller then treats the whole call as "no decision"). */
export function normaliseAnswer(a: WireAnswer | undefined): DecisionAnswer | null {
  if (!a || typeof a !== 'object') return null;
  switch (a.type) {
    case 'noul':
      return typeof a.noul === 'number' ? { type: 'noul', probability: a.noul } : null;
    case 'choice':
      return typeof a.choice === 'string'
        ? {
            type: 'choice',
            choice: a.choice,
            confidence: num(a.confidence),
            probabilities: a.probabilities ?? {},
          }
        : null;
    case 'score':
      return typeof a.score === 'number'
        ? {
            type: 'score',
            score: a.score,
            confidence: num(a.confidence),
            probabilities: a.probabilities ?? {},
          }
        : null;
    default:
      return null;
  }
}

/** The privacy level as OpenRouter's provider preferences. Anything but an
 *  exact `no_training` is `zdr`: an unknown value never loosens the call. */
export function decisionProviderPrefs(privacy: DecisionPrivacy | undefined): {
  zdr?: true;
  data_collection: 'deny';
} {
  return privacy === 'no_training'
    ? { data_collection: 'deny' }
    : { zdr: true, data_collection: 'deny' };
}

/** Build the request body. Exported for the wire-shape test. */
export function buildDecisionBody(opts: DecisionOptions): Record<string, unknown> {
  return {
    model: opts.model,
    state: opts.state,
    questions: opts.questions,
    provider: decisionProviderPrefs(opts.privacy),
  };
}

/** The error text for a failed call. A 404 under `zdr` is most often a model
 *  with no zero-retention route, so it names the admin's choice; the call is
 *  never repeated with less privacy. */
export function decisionErrorMessage(
  status: number,
  providerMessage: string,
  opts: Pick<DecisionOptions, 'model' | 'privacy'>,
): string {
  const base = `openrouter-decision ${status}: ${providerMessage}`;
  if (status !== 404 || decisionProviderPrefs(opts.privacy).zdr !== true) return base;
  return (
    `${base}. If '${opts.model}' has no zero-data-retention route, every call to it fails under ` +
    `privacy 'zdr'. An admin may lower the decider's privacy to 'no_training' (no data ` +
    `collection, retention allowed): untick 'Request zero data retention' on the decider ` +
    `worker, which saves zdr: false. Mantle never loosens privacy by itself.`
  );
}

export const openrouterDecisionAdapter: DecisionDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-decision',

  async decide(opts: DecisionOptions): Promise<DecisionResult> {
    const res = await providerFetch(
      DECISIONS_URL,
      {
        method: 'POST',
        headers: headers(opts.apiKey),
        body: JSON.stringify(buildDecisionBody(opts)),
      },
      { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
    const text = await res.text();
    let json: WireResponse | null;
    try {
      json = JSON.parse(text) as WireResponse;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // The provider's words stay on the error (the log, the owner's trace);
      // a member or the model hears the fixed sentence.
      const msg = json?.error?.message ?? text.slice(0, 300);
      throw new ProviderHttpError({
        provider: 'openrouter',
        status: res.status,
        body: text,
        message: decisionErrorMessage(res.status, msg, opts),
      });
    }
    if (!json || !json.answers || typeof json.answers !== 'object') {
      throw new Error('openrouter-decision: response carried no answers');
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const key of Object.keys(opts.questions)) {
      const a = normaliseAnswer(json.answers[key]);
      if (!a) throw new Error(`openrouter-decision: no usable answer for question '${key}'`);
      answers[key] = a;
    }
    return {
      answers,
      model: json.model ?? opts.model,
      tokensIn: num(json.usage?.input_tokens),
      tokensOut: num(json.usage?.output_tokens),
      reportedCostUsd: num(json.usage?.cost) || undefined,
    };
  },
};

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
 * Privacy: `zeroDataRetention` sends `provider: { zdr: true, data_collection:
 * 'deny' }`, both of which OpenRouter honours on this endpoint (verified
 * 2026-09-21). Raw fetch, same auth + attribution headers as the other
 * OpenRouter adapters so OR's dashboard sees one fingerprint.
 */

import type { DecisionAnswer, DecisionDispatcher, DecisionOptions, DecisionResult } from './types';
import { OPENROUTER_BASE_URL } from '../catalogs/openrouter';

/** `${OPENROUTER_BASE_URL}` is `…/api/v1`; decisions live one level up. */
const DECISIONS_URL = OPENROUTER_BASE_URL.replace(/\/v1\/?$/, '') + '/alpha/decisions';

const DEFAULT_TIMEOUT_MS = 1_500;

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

/** Build the request body. Exported for the wire-shape test. */
export function buildDecisionBody(opts: DecisionOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    state: opts.state,
    questions: opts.questions,
  };
  if (opts.zeroDataRetention !== false) {
    body.provider = { zdr: true, data_collection: 'deny' };
  }
  return body;
}

export const openrouterDecisionAdapter: DecisionDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-decision',

  async decide(opts: DecisionOptions): Promise<DecisionResult> {
    const res = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify(buildDecisionBody(opts)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: WireResponse | null;
    try {
      json = JSON.parse(text) as WireResponse;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? text.slice(0, 300);
      throw new Error(`openrouter-decision ${res.status}: ${msg}`);
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

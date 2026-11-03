/**
 * The decider worker's Test button (docs/decisions.md "The Test button"):
 * ONE small request to the worker's saved model, sent as production sends
 * it (`sendDecision`): the worker's real privacy level, its real timeout,
 * and the model's real request limits. It answers ok, or the plain reason
 * it failed.
 *
 * The only caller of a model outside `decide()`, and only on an admin's
 * click: no cron, no trigger, no retry. A failure is never repeated with
 * less privacy. It works while the worker and every use are off (it checks
 * the key, the model and the route, not the switches), and it leaves the
 * breaker and the `decision` alert alone: the admin is looking at the
 * answer, and a model not yet saved as the default must not close the
 * default's alert.
 */
import { resolveProviderKey } from '@mantle/api-keys';
import type { AiWorker, DeciderParams } from '@mantle/db';
import { PROVIDER_ERROR_REASONS, errorMessage } from '@mantle/std';
import {
  getDecisionAdapter,
  type DecisionAnswer,
  type DecisionPrivacy,
  type DecisionQuestion,
} from '@mantle/voice';
import { sendDecision, timeoutOf } from './decide';
import { DECISION_FAILURE_REASONS, decisionFailureClass } from './failure';
import { deciderPrivacy } from './privacy';
import { limitsForModel, requestOverLimit } from './request-limits';

/** The default sample: nothing of the owner's. */
export const DECISION_TEST_SAMPLE =
  'My checkout page shows a blank screen after I click Pay. I have tried two browsers.';

/** Three fixed questions, one of each type: small enough for any model's
 *  limits, so a failure is about the model, not the request. */
export const DECISION_TEST_QUESTIONS: Record<string, DecisionQuestion> = {
  team: {
    type: 'choice',
    instructions: 'Which team should own `message`?',
    criteria: {
      account: 'Login, permissions, or profile issues.',
      frontend: 'Rendering, layout, or browser compatibility issues.',
      payments: 'Checkout, billing, or payment processing issues.',
      other: 'Anything else.',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is `message`?',
    criteria: ['Can wait for the next release', 'Should be fixed this week', 'Blocking right now'],
  },
  is_bug: {
    type: 'noul',
    instructions: 'Does `message` report broken or unexpected product behaviour?',
  },
};

/** What the Test button shows (mirrored as `DecisionTestResult` in
 *  @mantle/client-types). */
export type DecisionTestResult = {
  /** The model and the settings the request went out with. */
  model: string;
  provider: string;
  privacy: DecisionPrivacy;
  timeoutMs: number;
  ms: number;
} & (
  | {
      ok: true;
      adapter: string;
      tokensIn: number | null;
      costUsd: number | null;
      answers: Record<string, DecisionAnswer>;
    }
  | {
      ok: false;
      /** The failure's code (failure.ts, or the provider classifier's). */
      code: string;
      /** One fixed sentence for an admin. */
      reason: string;
      /** The provider's or the adapter's own words, for the owner only. */
      detail: string | null;
    }
);

/** Send the sample through `worker` and say how it went. Throws only for a
 *  worker that is not a decider (the route's 400); every model failure is a
 *  result. */
export async function testDecisionWorker(
  ownerId: string,
  worker: Pick<AiWorker, 'kind' | 'slug' | 'provider' | 'model' | 'apiKeyId' | 'params'>,
  text: string,
): Promise<DecisionTestResult> {
  if (worker.kind !== 'decider') throw new Error(`worker '${worker.slug}' is not a decider`);
  const params = (worker.params ?? {}) as DeciderParams;
  const privacy = deciderPrivacy(params);
  const timeoutMs = timeoutOf(params);
  const base = { model: worker.model, provider: worker.provider, privacy, timeoutMs };
  const fail = (code: string, reason: string, detail: string | null = null, ms = 0) =>
    ({ ...base, ms, ok: false, code, reason, detail }) as const;

  const adapter = getDecisionAdapter(worker.provider);
  if (!adapter) return fail('no_adapter', DECISION_FAILURE_REASONS.no_adapter);
  const apiKey = (await resolveProviderKey(ownerId, worker.provider, worker.apiKeyId))?.apiKey;
  if (!apiKey) return fail('no_key', PROVIDER_ERROR_REASONS.no_key);

  const state = { message: (text ?? '').trim() || DECISION_TEST_SAMPLE };
  const limits = limitsForModel(worker.model);
  const over = requestOverLimit(limits, state, DECISION_TEST_QUESTIONS);
  if (over) return fail('over_limit', DECISION_FAILURE_REASONS.over_limit, over.reason);

  const t0 = Date.now();
  try {
    const res = await sendDecision({
      adapter,
      apiKey,
      model: worker.model,
      params,
      state,
      questions: DECISION_TEST_QUESTIONS,
      limits,
    });
    return {
      ...base,
      model: res.model,
      ms: Date.now() - t0,
      ok: true,
      adapter: adapter.adapterName,
      tokensIn: res.tokensIn ?? null,
      costUsd: res.reportedCostUsd ?? null,
      answers: res.answers,
    };
  } catch (err) {
    const cls = decisionFailureClass(err, privacy);
    return fail(cls.code, cls.reason, errorMessage(err), Date.now() - t0);
  }
}

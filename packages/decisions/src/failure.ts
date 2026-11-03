/**
 * A decider failure, in words an admin can act on (docs/decisions.md
 * "Failures an admin sees"). One reading for the two places a decision can
 * fail: `decide()`, which reports it to the `decision` provider alert, and
 * the worker's Test button, which shows it.
 *
 * The reason is a fixed sentence picked by code, never provider text: it is
 * safe on a banner and a phone. The provider's own words stay on the error
 * (the log, the owner's trace, the Test button's detail line).
 */
import type { ProviderFailureClass } from '@mantle/embeddings/provider-outage';
import { classifyProviderError, providerErrorStatus } from '@mantle/std';
import type { DecisionPrivacy } from '@mantle/voice';

/** The decider's own codes, beside the classifier's (`quota`, `auth`,
 *  `model`, `timeout` and the rest). */
export const DECISION_FAILURE_REASONS = {
  /** A 404 under `zdr`: most often no zero-retention route for the model. */
  privacy_route:
    "No route for this model meets the decider's privacy setting (zero data retention), or the provider does not offer the model. An admin chooses: another model, or a lower privacy level on the decider worker. The brain never lowers it by itself.",
  /** The model reported exactly its token limit: the request may be cut. */
  cut: 'The model reported exactly its input limit, so the request may have been cut. The answer was not used.',
  /** An answer came back, but not one the decider can use. */
  answer: 'The model did not answer with usable decisions.',
  /** The request is larger than the model takes (never sent). */
  over_limit: 'The request is larger than this model takes, so it was not sent.',
  no_adapter: 'Mantle has no decision adapter for this provider.',
} as const;

/** `decide()` throws this for a suspected silent cut (Part 2,
 *  request-limits.ts), so the failure is named by its kind, not its text. */
export class DecisionCutError extends Error {
  override readonly name = 'DecisionCutError';
  constructor(cutAt: number) {
    super(
      `suspected silent cut: the model reported exactly ${cutAt} input tokens, ` +
        'its limit, so the answer is not used',
    );
  }
}

/**
 * Pure: the class of a failed decision. Never null: every failure of the
 * decider is one an admin may need to see, even where the general
 * classifier says nothing about the provider (an unusable answer).
 * Transient codes (timeouts, server errors, unusable answers) are shown
 * only once they have lasted 10 min; permanent ones at once.
 */
export function decisionFailureClass(err: unknown, privacy: DecisionPrivacy): ProviderFailureClass {
  if (err instanceof DecisionCutError) {
    return { code: 'cut', permanent: false, reason: DECISION_FAILURE_REASONS.cut };
  }
  const cls = classifyProviderError(err);
  if (cls?.code === 'model' && providerErrorStatus(err) === 404 && privacy === 'zdr') {
    return {
      code: 'privacy_route',
      permanent: true,
      reason: DECISION_FAILURE_REASONS.privacy_route,
    };
  }
  if (cls) return { code: cls.code, permanent: cls.permanent, reason: cls.reason };
  return { code: 'answer', permanent: false, reason: DECISION_FAILURE_REASONS.answer };
}

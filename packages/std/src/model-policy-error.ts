/**
 * The box policy's refusal of a model call (MANTLE_POLICY_MODEL_DENY,
 * MANTLE_POLICY_PROVIDER_ALLOW; @mantle/config policy.ts, docs/policy.md).
 * Thrown by the one model check (@mantle/voice model-policy.ts) before any
 * byte goes to the provider, and by a save route that would pick a blocked
 * model. A domain error: the caller hears 403 and the message, which names
 * the rule and says to choose an allowed model; a tool and a chat reply say
 * the same words. The provider classifier reads it as `policy` (permanent),
 * so an embedding or extraction outage alert names it and a chat route
 * with an allowed backup fails over to it.
 */
import { defineDomainError } from './domain-errors';

/** The error's name, which the provider classifier matches (a second copy
 *  of this module in a bundle still matches). */
export const MODEL_POLICY_ERROR_NAME = 'ModelPolicyError';

/** Which rule refused: the provider allow-list, the deny list, or an auto
 *  router while a deny list is set. */
export type ModelPolicyRule = 'provider_allow' | 'model_deny' | 'auto_router';

export class ModelPolicyError extends Error {
  readonly rule: ModelPolicyRule;
  readonly provider: string;
  readonly model: string;
  constructor(message: string, info: { rule: ModelPolicyRule; provider: string; model: string }) {
    super(message);
    this.name = MODEL_POLICY_ERROR_NAME;
    this.rule = info.rule;
    this.provider = info.provider;
    this.model = info.model;
  }
}

defineDomainError(ModelPolicyError, {
  reason:
    'the box policy blocks the provider or model the caller picked; the message names the rule',
  status: 403,
  body: (e) => ({ error: e.message, code: 'model_policy', rule: e.rule }),
});

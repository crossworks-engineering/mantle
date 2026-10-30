/**
 * THE model check of the box policy (MANTLE_POLICY_MODEL_DENY and
 * MANTLE_POLICY_PROVIDER_ALLOW; @mantle/config policy.ts, docs/policy.md).
 *
 * Every adapter the registry hands out is wrapped by the recording point
 * (spend.ts), and each wrapper asks this before its call: chat (a turn, its
 * backup route and failover, a sub-agent, invoke_agent, the summarizer,
 * the extractor), the decider, embeddings, vision, speech and images, on
 * every provider (the direct deepseek adapter too). The one inference call
 * that builds its own client, web search (@mantle/tools builtins-research),
 * asks it by hand. A refused call throws ModelPolicyError before any byte
 * goes to the provider, and opens the `model_policy` provider alert (one
 * write a minute per process).
 *
 * With no model rule set this is one property read and returns: a box
 * without the policy calls exactly what it called before.
 */
import { modelPolicyRefusal } from '@mantle/config';
import { recordProviderFailure, resolveSingleOwnerId } from '@mantle/db';
import { ModelPolicyError, PROVIDER_ERROR_REASONS, errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** The log, taken when a refusal writes one (never at import). */
const policyLog = () => log('model-policy');

/** The capability a call is for (the alert names it in the log). */
export type ModelCapability =
  'chat' | 'decision' | 'embedding' | 'vision' | 'image_gen' | 'tts' | 'stt' | 'search';

const ALERT_EVERY_MS = 60_000;
let lastAlertAt = 0;

/** Open the `model_policy` alert for the brain, at most once a minute per
 *  process; never throws (the refusal is the caller's answer). */
function noteRefusal(provider: string, model: string): void {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_EVERY_MS) return;
  lastAlertAt = now;
  void (async () => {
    const ownerId = await resolveSingleOwnerId();
    if (!ownerId) return;
    await recordProviderFailure(ownerId, 'model_policy', {
      code: 'policy',
      permanent: true,
      reason: PROVIDER_ERROR_REASONS.policy,
      provider,
      model: model || null,
    });
  })().catch((err) => {
    policyLog().warn(`could not record the alert: ${errorMessage(err)}`);
  });
}

/** Tests only: the next refusal writes its alert again. */
export function resetModelPolicyAlertThrottleForTests(): void {
  lastAlertAt = 0;
}

/**
 * Throw ModelPolicyError when the box policy blocks `provider` and `model`
 * for `capability`; return when it allows them (always, with no rule set).
 * `model` may be empty where the adapter picks its own default (a speech
 * call): the provider rules still apply.
 */
export function assertModelAllowed(
  capability: ModelCapability,
  provider: string,
  model: string | null | undefined,
  /** The route's own base URL (a chat or embedding call), if it names one. */
  baseUrl?: string | null,
): void {
  const refusal = modelPolicyRefusal(provider, model, baseUrl);
  if (!refusal) return;
  policyLog().warn(`refused ${capability} on ${provider}/${model || '(default)'}: ${refusal.rule}`);
  noteRefusal(provider, model ?? '');
  throw new ModelPolicyError(refusal.message, {
    rule: refusal.rule,
    provider,
    model: model ?? '',
  });
}

/** Whether the box policy allows `provider` and `model` (a pick list's
 *  filter, a save route's check): no throw, no alert. */
export function modelAllowed(
  provider: string,
  model: string | null | undefined,
  baseUrl?: string | null,
): boolean {
  return modelPolicyRefusal(provider, model, baseUrl) === null;
}

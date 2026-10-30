/**
 * The box policy's model block at save time (docs/policy.md): a route that
 * saves a provider and model (an assistant, a worker, a model pool, a model
 * combo, the embedder) refuses one the policy blocks, in the policy's own
 * words, so a blocked model is never configured by hand. The call-time
 * check (@mantle/voice model-policy.ts) still refuses every call, whatever
 * a row holds (a default seeded before the policy, a row written in SQL).
 *
 * With no model rule set this answers null at once: every save is as
 * before.
 */
import { modelPolicyRefusal } from '@mantle/config';

/** What a save of `provider` and `model` is refused with, or null when the
 *  policy allows it (or names no model rule). An empty provider or model
 *  names no route here (the route's own schema decides). */
export function modelPolicyIssue(
  provider: string | null | undefined,
  model: string | null | undefined,
  /** The route's own base URL, where the save names one. */
  baseUrl?: string | null,
): string | null {
  // An agent that inherits its model (`inherit`) has no route of its own:
  // the route it inherits is checked where it is saved.
  if (!provider || !model || model === 'inherit') return null;
  return modelPolicyRefusal(provider, model, baseUrl)?.message ?? null;
}

/** The first refusal over a save's routes (the primary, the backup), or
 *  null. */
export function modelRoutesPolicyIssue(
  routes: ReadonlyArray<
    readonly [string | null | undefined, string | null | undefined, (string | null | undefined)?]
  >,
): string | null {
  for (const [provider, model, baseUrl] of routes) {
    const issue = modelPolicyIssue(provider, model, baseUrl);
    if (issue) return issue;
  }
  return null;
}

/** The HTTP body of a refused save (403, as a refused call answers). */
export function modelPolicyBody(issue: string): { error: string; code: 'model_policy' } {
  return { error: issue, code: 'model_policy' };
}

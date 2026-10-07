/**
 * Thinking-effort tiers — the vocabulary shared by the settings UI and the
 * provider adapters.
 *
 * Its own leaf module, with NO imports, because the settings page needs the
 * values in the browser and `profile-preferences.ts` pulls in `@mantle/db`.
 * Importing the barrel from client code drags the server tree into the bundle
 * (see the leaf-import warning in profile-client.tsx). `profile-preferences`
 * re-exports everything here, so server-side callers see no difference.
 */

/** Reasoning-depth tiers the providers accept, ascending. Provider-neutral:
 *  OpenRouter takes these verbatim as `reasoning.effort`, Anthropic as
 *  `output_config.effort`, Copilot as `reasoning_effort`.
 *
 *  No `none`: "off" is expressed by omitting the field entirely, because models
 *  flagged `reasoning.mandatory` in OpenRouter's GET /models reject an explicit
 *  none. Mirrored as `ThinkingEffort` in `@mantle/voice` (which must not depend
 *  on this package); a compile-time assertion in `@mantle/runtime/assistant`
 *  pins the two lists together. */
export const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/** The token values the settings dropdown stores, paired with the effort tier
 *  each one means. CANONICAL — the settings UI renders its options from this
 *  list rather than keeping its own copy, so a visible label and the effort
 *  actually sent cannot drift apart.
 *
 *  Why a token number still backs an effort tier: the stored preference has
 *  always been a token count, and re-keying it would need a migration plus a
 *  fallback for every existing user. The number is now just the tier's id.
 *  Real budgets stopped meaning anything upstream anyway — on Sonnet 5 and
 *  Claude 4.7 budget-based thinking is removed, `reasoning.max_tokens` is
 *  accepted-but-ignored, and effort is the only remaining control. */
export const THINKING_TIERS: ReadonlyArray<{
  budget: number;
  effort: ThinkingEffort | null;
  label: string;
}> = [
  { budget: 0, effort: null, label: 'Off' },
  { budget: 1024, effort: 'low', label: 'Low' },
  { budget: 4096, effort: 'medium', label: 'Medium' },
  { budget: 8000, effort: 'high', label: 'High' },
];

/** Map a stored budget to its effort tier, snapping an off-tier number (an
 *  operator or the API may set one) to the nearest tier rather than dropping it
 *  — an unrecognised number should still mean the depth closest to what was
 *  asked for, not silently no reasoning at all. */
export function thinkingEffortForBudget(budget: number | undefined): ThinkingEffort | undefined {
  if (!budget || budget <= 0) return undefined;
  const nearest = THINKING_TIERS.reduce((best, t) =>
    Math.abs(t.budget - budget) < Math.abs(best.budget - budget) ? t : best,
  );
  return nearest.effort ?? undefined;
}

/** The values an AGENT's own thinking effort may hold (`agents.thinking_effort`,
 *  migration 0228): 'off' plus every tier. NULL (not in this list) means
 *  "inherit the person's profile setting". Wider than THINKING_TIERS on
 *  purpose: the profile dropdown stops at High, but an agent may ask for the
 *  upper rungs; the provider adapters downgrade a rung a model lacks (see
 *  anthropicEffort in @mantle/voice). The migration's CHECK holds this list. */
export const AGENT_THINKING_EFFORTS = ['off', ...THINKING_EFFORTS] as const;
export type AgentThinkingEffort = (typeof AGENT_THINKING_EFFORTS)[number];

/** Labels for the agent select, in order. */
export const AGENT_THINKING_EFFORT_LABELS: Record<AgentThinkingEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Narrow an unknown value to an agent effort. Anything else (null, '',
 *  'inherit', a typo) is null = inherit, so a bad value can never turn
 *  reasoning ON. */
export function parseAgentThinkingEffort(raw: unknown): AgentThinkingEffort | null {
  return typeof raw === 'string' && (AGENT_THINKING_EFFORTS as readonly string[]).includes(raw)
    ? (raw as AgentThinkingEffort)
    : null;
}

/** The budget (tier id) that backs an effort. The runtime still gates on a
 *  positive budget and sizes the max_tokens headroom from it (see
 *  clampThinkingBudget / resolveMaxTokens in @mantle/runtime), so an agent's
 *  effort needs one. The profile tiers keep their ids; the two upper rungs
 *  have no profile tier, so they get a larger headroom of their own (24000 is
 *  the profile route's ceiling). */
export function thinkingBudgetForEffort(effort: ThinkingEffort): number {
  const tier = THINKING_TIERS.find((t) => t.effort === effort);
  if (tier) return tier.budget;
  return effort === 'xhigh' ? 16000 : 24000;
}

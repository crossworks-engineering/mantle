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
 *  on this package); a compile-time assertion in `@mantle/assistant-runtime`
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

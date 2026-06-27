/**
 * Pure web-default agent selection (docs/comms-channels.md §6, decision 5).
 *
 * Extracted from `resolveAssistantAgent` (run-turn.ts) so the priority +
 * tiebreak decision is unit-testable with no DB — mirrors the pattern used by
 * `resolveEffectivePersona` (system-manifest/persona.ts). The resolver fetches
 * the enabled chat-capable candidates; this picks the winner deterministically.
 *
 * Transport is decoupled from `role` (channels own that now); `role` here is
 * ONLY a soft tiebreak that preserves the historical "assistant first" feel
 * without letting it gate the surface. Equal-priority agents used to resolve
 * non-deterministically — the slug tiebreak below makes the pick stable.
 */

/** Soft role tiebreak — applied only when priorities are equal. Lower wins. */
export const ROLE_TIEBREAK: Record<string, number> = { assistant: 0, responder: 1, custom: 2 };

export type WebDefaultCandidate = { slug: string; role: string; priority: number | null };

/**
 * Pick the web-default agent: highest `priority`, then a soft
 * assistant→responder→custom tiebreak, then slug for determinism. Returns null
 * for an empty list. Does not mutate the input.
 */
export function pickWebDefaultAgent<T extends WebDefaultCandidate>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  return (
    [...candidates].sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        (ROLE_TIEBREAK[a.role] ?? 9) - (ROLE_TIEBREAK[b.role] ?? 9) ||
        a.slug.localeCompare(b.slug),
    )[0] ?? null
  );
}

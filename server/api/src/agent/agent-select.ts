/**
 * Pure agent-selection helpers for the Telegram inbound path + the reflector
 * (docs/comms-channels.md §6). Split out of main.ts/reflector.ts so the
 * resolution logic is unit-testable with no DB — and so main.ts (which runs
 * `main()` at import) needn't be imported by a test. Mirrors the pure
 * `resolveEffectivePersona` pattern in system-manifest/persona.ts.
 */

/**
 * Conversational roles eligible for the role-agnostic fallback + persona
 * learning. NOT a transport gate (channels own transport now) — this only keeps
 * the background pipeline workers (extractor/summarizer/reflector) out of the
 * set of agents that can hold a chat. `role` is a loose hint post-decouple
 * (docs/comms-channels.md §7, decision A).
 */
export const CONVERSATIONAL_ROLES = ['assistant', 'responder', 'custom'] as const;
export type ConversationalRole = (typeof CONVERSATIONAL_ROLES)[number];

const CONVERSATIONAL_SET: ReadonlySet<string> = new Set(CONVERSATIONAL_ROLES);

export type FallbackCandidate = {
  slug: string;
  role: string;
  priority: number | null;
  enabled?: boolean;
};

/**
 * Last-resort inbound pick when no per-chat override and no bound channel agent
 * applies: the highest-priority enabled conversational agent, then slug for
 * determinism (equal priorities used to resolve non-deterministically). Returns
 * null when no conversational agent exists, so an inbound is never handed to a
 * background worker. Does not mutate the input.
 */
export function pickFallbackResponder<T extends FallbackCandidate>(agents: T[]): T | null {
  const conv = agents.filter((a) => (a.enabled ?? true) && CONVERSATIONAL_SET.has(a.role));
  if (conv.length === 0) return null;
  return (
    [...conv].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.slug.localeCompare(b.slug),
    )[0] ?? null
  );
}

/**
 * Reflector activity gate: keep only agents with >0 new outbound turns since the
 * last run (the `activity` map is agentId → count), most-active first, then slug
 * for a deterministic order at the per-tick cap boundary. The cost-safety gate —
 * an agent earns an LLM reflection only if the user actually conversed with it.
 * Does not mutate the input.
 */
export function rankActiveAgents<T extends { id: string; slug: string }>(
  candidates: T[],
  activity: Map<string, number>,
): T[] {
  return candidates
    .filter((c) => (activity.get(c.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || a.slug.localeCompare(b.slug),
    );
}

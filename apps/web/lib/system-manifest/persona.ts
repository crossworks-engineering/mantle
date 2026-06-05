/**
 * Slug-flexible persona resolution for the integrity checker.
 *
 * The manifest's canonical persona is slug `assistant` (role `responder`). But a
 * brain hand-built BEFORE onboarding existed carries an operator persona instead
 * (e.g. `telegram-default`/Saskia) and never had the slug `assistant`. Keying the
 * persona + delegation checks on the literal slug makes those brains read red for
 * a slug they were never going to have.
 *
 * This resolves the agent that ACTUALLY serves as the persona, mirroring the
 * runtime resolver `resolveAssistantAgent` (apps/web/lib/assistant.ts): prefer
 * the canonical slug; otherwise the highest-priority enabled responder (role
 * `assistant` before `responder`). Pure — no DB — so it's unit-tested directly.
 */

import { PERSONA_SLUG } from './manifest';

export type PersonaCandidate = {
  slug: string;
  enabled: boolean;
  role: string;
  priority: number;
};

/**
 * Pick the agent the checker should measure as the persona/delegation entry point.
 *
 * - If the manifest slug `assistant` is present, use it **regardless of enabled**
 *   — a freshly onboarded brain is measured against the canonical persona, and a
 *   disabled one is still honestly flagged (rather than silently swapped out).
 * - If that slug is entirely absent (hand-built brain), fall back to the
 *   highest-priority enabled responder, role `assistant` preferred over
 *   `responder` — matching `resolveAssistantAgent`.
 *
 * Returns null only when there's no persona candidate at all.
 */
export function resolveEffectivePersona<T extends PersonaCandidate>(agents: T[]): T | null {
  const canonical = agents.find((a) => a.slug === PERSONA_SLUG);
  if (canonical) return canonical;
  const responders = agents
    .filter((a) => a.enabled && (a.role === 'assistant' || a.role === 'responder'))
    .sort(
      (x, y) =>
        (x.role === 'assistant' ? 0 : 1) - (y.role === 'assistant' ? 0 : 1) ||
        y.priority - x.priority,
    );
  return responders[0] ?? null;
}

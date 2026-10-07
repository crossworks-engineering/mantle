/**
 * Pure helper for the boot reconcile. Dependency-free so it's unit-testable
 * (the vitest setup loads pure-logic modules only, not @/-aliased / DB code).
 */
import { createHash } from 'node:crypto';

/**
 * The shipped prompt an agent should move to on upgrade, or null to leave its
 * prompt alone. A prompt is replaced only when it is, byte for byte, one of
 * the defaults the manifest shipped before (`retiredSha256`, see
 * ManifestAgent.retiredPromptSha256): nobody edited it, so the new default is
 * what the operator would have had. Any edit, even whitespace, keeps it.
 */
export function shippedPromptUpgrade(
  live: string | null | undefined,
  current: string | undefined,
  retiredSha256: readonly string[] | undefined,
): string | null {
  if (live == null || !current || !retiredSha256?.length || live === current) return null;
  const hash = createHash('sha256').update(live, 'utf8').digest('hex');
  return retiredSha256.includes(hash) ? current : null;
}

/**
 * The manifest-persona groups an agent is MISSING. Reconcile uses this to UNION
 * new default groups onto an existing responder — it only ADDS, never removes,
 * so an operator's own grants (and removals of OTHER groups) are preserved. A
 * default group the operator deliberately removed will reappear after an update;
 * that's the manifest-as-capability-contract trade-off, and it's reversible.
 */
export function missingPersonaGroups(
  current: readonly string[] | null | undefined,
  manifestPersonaGroups: readonly string[],
): string[] {
  const have = new Set(current ?? []);
  return manifestPersonaGroups.filter((g) => !have.has(g));
}

const LEVEL_RANK: Record<string, number> = { public: 0, client: 1, team: 2, admin: 3 };

/**
 * Of the groups reconcile would add, keep only those at or below the agent's
 * level (member logins Phase 0b: an agent holds only groups at or below its
 * level). Without this, every image update re-added `team-read-admin` to a
 * team-responder an admin had lowered to team (seen on two boxes of the
 * fleet, v0.232.265): harmless at run time (the level cap drops it) but it
 * broke the rule and showed up in the shadow report. A group whose level is unknown
 * counts as admin, so only an admin agent gets it.
 */
export function groupsWithinLevel(
  groups: readonly string[],
  agentLevel: string | null | undefined,
  groupLevels: ReadonlyMap<string, string>,
): string[] {
  const cap = LEVEL_RANK[agentLevel ?? 'admin'] ?? 3;
  return groups.filter((g) => (LEVEL_RANK[groupLevels.get(g) ?? 'admin'] ?? 3) <= cap);
}

/**
 * Converge an agent's skill links toward the manifest — the remove-capable
 * counterpart to missingPersonaGroups (which only adds).
 *
 * The manifest authoritatively owns which of ITS OWN skills an agent carries.
 * So: keep every operator-authored skill (a slug the manifest doesn't own) and
 * every manifest skill the agent still wants; DROP a manifest-owned skill the
 * agent no longer wants — a RETIRED default, e.g. `rich_writing` once the persona
 * moved to `chat_writing`. Then attach any still-wanted skill not yet present.
 *
 * @param current        the agent's current skill_slugs
 * @param wanted         the skills the manifest assigns to THIS agent
 * @param manifestOwned  every slug the manifest owns (MANIFEST_SKILL_SLUGS)
 * @param addable        wanted slugs whose skill row exists + is enabled — the
 *                       only ones safe to attach. Defaults to `wanted` (caller
 *                       guarantees existence). The DROP side ignores this: a
 *                       wanted skill is never dropped just for being disabled.
 * @returns kept-current (operator + still-wanted) followed by newly-added wanted
 */
export function convergeManifestSkills(
  current: readonly string[] | null | undefined,
  wanted: readonly string[],
  manifestOwned: ReadonlySet<string>,
  addable: readonly string[] = wanted,
): string[] {
  const wantedSet = new Set(wanted);
  const kept = (current ?? []).filter((s) => !manifestOwned.has(s) || wantedSet.has(s));
  const have = new Set(kept);
  const added = addable.filter((s) => wantedSet.has(s) && !have.has(s));
  return [...kept, ...added];
}

/**
 * Agent params the OWNER sets per agent: switches, not tuning. The boot
 * reconcile and the per-item Adopt keep the stored value of these keys; the
 * manifest owns the rest (temperature, max_tokens). Decided 2026-10-05 ("keep
 * switches"): before, a tool_loading 'deferred' set on a specialist went back
 * to the manifest params on the next version's reconcile.
 */
export const OWNER_PARAM_KEYS = ['tool_loading', 'suggest_follow_up', 'top_p'] as const;

/** The params a specialist should hold after reconcile: the manifest's, with
 *  each OWNER_PARAM_KEYS value the live row carries laid on top. */
export function specialistParamsTarget(
  manifest: Record<string, unknown> | null | undefined,
  live: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(manifest ?? {}) };
  for (const k of OWNER_PARAM_KEYS) {
    if (live?.[k] !== undefined) out[k] = live[k];
  }
  return out;
}

/** Equal as stored jsonb: top-level key order does not count (Postgres jsonb
 *  re-orders keys, so a plain JSON.stringify compare of a row against a
 *  literal can differ on order alone). */
export function sameTopLevel(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  const norm = (o: Record<string, unknown> | null | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

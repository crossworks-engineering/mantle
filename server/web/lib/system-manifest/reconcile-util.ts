/**
 * Pure helper for the boot reconcile. Dependency-free so it's unit-testable
 * (the vitest setup loads pure-logic modules only, not @/-aliased / DB code).
 */
import { createHash } from 'node:crypto';
import { TEAM_RESPONDER_SLUG } from '@mantle/runtime/assistant';

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

/** The team responder's slug (manifest.ts): the Team workspace's assistant
 *  on a brain switched before 0286 (the 0251 attach rule). A newer brain has
 *  no Team: no workspace holds it until an Admin user attaches it. One
 *  source, the runtime's (A5 step 6d: it was defined twice). */
export { TEAM_RESPONDER_SLUG };

/**
 * Of the groups reconcile would add, keep only those the agent may use
 * (workspaces W8c; it was the agent's level until then): an adminOnly group
 * (0254) is never added to the assistant of a workspace other than Admin,
 * nor to the team responder on no workspace (the Team assistant of a brain
 * not yet switched, whose role is custom), nor, on a brain on workspaces,
 * to a responder or assistant on no workspace: its turns never hold the
 * Admin workspace. On a brain not on workspaces such a responder is the
 * owner's own persona and keeps them all (W8 integration). Without this,
 * every image update re-added `team-read-admin` to the team responder (seen
 * on two boxes of the fleet, v0.232.265). Every other agent gets them all.
 */
export function groupsForAgent(
  groups: readonly string[],
  agent: { workspace: 'admin' | 'other' | 'none'; role?: string | null; slug?: string | null },
  adminOnlyGroups: ReadonlySet<string>,
  brainOnWorkspaces: boolean,
): string[] {
  const outsideAdmin =
    agent.workspace === 'other' ||
    (agent.workspace === 'none' &&
      (agent.slug === TEAM_RESPONDER_SLUG ||
        (brainOnWorkspaces && (agent.role === 'responder' || agent.role === 'assistant'))));
  return outsideAdmin ? groups.filter((g) => !adminOnlyGroups.has(g)) : [...groups];
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

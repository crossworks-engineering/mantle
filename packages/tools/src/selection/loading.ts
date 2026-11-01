/**
 * Which tool-loading mode a turn runs in: `full` (every granted tool in
 * full), `deferred` (deferred.ts) or `map` (map.ts).
 *
 * An agent's own `params.tool_loading` always wins. With none set, an
 * assistant (role `responder` or `assistant`) runs on the map: that is the
 * class the 2026-10-31 bench and the dev trial measured (about even with
 * deferred on right first tool, cheaper per turn). A Haiku model scored
 * lower on the map (86 vs 91 of 101), so it runs deferred. Every other role
 * (specialists, workers) stays on `full` until it is measured on the map.
 *
 * Pure: the tool loop calls it once per turn.
 */

export type ToolLoading = 'full' | 'deferred' | 'map';

const ASSISTANT_ROLES: ReadonlySet<string> = new Set(['responder', 'assistant']);

/** A model that measured lower on the map than on deferred loading. */
function mapIsWeakFor(model: string): boolean {
  return /haiku/i.test(model);
}

export function resolveToolLoading(
  set: unknown,
  role: string | null | undefined,
  model: string,
): ToolLoading {
  if (set === 'full' || set === 'deferred' || set === 'map') return set;
  if (!role || !ASSISTANT_ROLES.has(role)) return 'full';
  return mapIsWeakFor(model) ? 'deferred' : 'map';
}

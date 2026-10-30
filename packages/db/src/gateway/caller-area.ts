/**
 * The one answer to "may the caller of this code do Admin `area`?" for the
 * gates that ask it after the surface let a call in: @mantle/tools' tool
 * gate (admin-gate.ts re-exports it) and the vault's write gateway
 * (@mantle/api-keys vault.ts). A gate by design, so its asks are not
 * re-asks (eslint-rules/admin-counts.mjs AREA_GATES).
 */
import { currentWorkspaceScope, scopeLeftForSystem, type ScopeArea } from '../viewer';
import { withTurnScope } from './scope';
import { scopeHasArea } from './scope-answers';

/**
 * Whether the caller of the current code may do Admin `area`: asked in the
 * open workspace scope, or, on the system pool (an Admin-area tool run whole,
 * an areaSystem block, an area route), in the scope its asSystem left, so a
 * connectors-area tool can ask whether its caller also holds the keys area.
 * Outside any workspace scope with none left (system work, an area route
 * past its gate): yes, the surface or the route gate decided.
 */
export async function callerHasArea(area: ScopeArea): Promise<boolean> {
  if (currentWorkspaceScope()) return scopeHasArea(area);
  const left = scopeLeftForSystem();
  if (!left) return true;
  return withTurnScope(left, () => scopeHasArea(area));
}

/**
 * callerHasArea, failing closed outside every scope: there it answers yes
 * only to bound system work (an area route past its gate binds one), and
 * with nothing bound it throws SystemWorkRequiredError (scopeHasArea's
 * answer, docs/fail-open.md), so a caller the gates never saw is refused.
 * The vault's write gateway asks this.
 */
export async function callerHasAreaBound(area: ScopeArea): Promise<boolean> {
  if (currentWorkspaceScope()) return scopeHasArea(area);
  const left = scopeLeftForSystem();
  if (!left) return scopeHasArea(area);
  return withTurnScope(left, () => scopeHasArea(area));
}

/**
 * Whether the current code runs in a workspace scope that does not hold the
 * Admin workspace: a user's MCP scope outside Admin (workspaces W7b), or the
 * turn scope of a workspace other than Admin (a workspace assistant's turn,
 * its run, a delegated child of either). Unscoped work is not outside Admin.
 * One reading for the app tools' author ceiling and the delegation gateway
 * (a workspace turn delegates to the workspace delegates only), so the two
 * cannot drift. A leaf module: the turn assembly imports it with no tool
 * registry.
 */
import { scopeHoldsAdmin } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import type { DelegationTurn } from './invoke-agent-guards';
import { isOwnerSurface } from './surface';
import type { ToolHandlerContext } from './types';

export async function scopeOutsideAdmin(): Promise<boolean> {
  return currentWorkspaceScope() !== null && !(await scopeHoldsAdmin());
}

/**
 * What the delegation gateway (checkDelegationAllowed) knows of the turn a
 * delegation starts in, read from the turn itself, never from arguments: a
 * WORKSPACE turn when its surface is not the owner's (a team surface, a
 * missing one: fail closed) or its scope does not hold the Admin workspace
 * (any workspace assistant's turn, whatever its surface); and the login its
 * scope answers. An Admin turn (an owner surface in a scope that holds
 * Admin, or unscoped owner work) keeps the allowlist alone. The one
 * definition of a workspace turn: the invoke_agent handler, the runtime
 * invoker and the turn assembly (what the model is shown) all read it here,
 * so the three cannot drift. Call it in the turn's scope.
 */
export async function delegationTurnOf(
  surface: ToolHandlerContext['surface'],
): Promise<DelegationTurn> {
  const workspaceTurn = !isOwnerSurface(surface) || (await scopeOutsideAdmin());
  return { workspaceTurn, loginId: currentWorkspaceScope()?.loginId ?? null };
}

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

export async function scopeOutsideAdmin(): Promise<boolean> {
  return currentWorkspaceScope() !== null && !(await scopeHoldsAdmin());
}

/**
 * What is left of the levels: nothing decides access by a level. Brain
 * items are read by their grants, and agents and tool groups have no level
 * either: an assistant reads the workspace it answers in, and a tool group
 * is system-wide or Admin only (tool_groups.admin_only, the manifest's
 * adminOnly groups). The level columns are archived by migration 0268.
 */
import { WORKSPACE_NODE_TYPES } from '@mantle/db';
import { revokeShareTree } from './shares';

const WORKSPACE = new Set<string>(WORKSPACE_NODE_TYPES);

/** Whether a node type may live in a workspace other than Admin. */
export function isWorkspaceKind(type: string): boolean {
  return WORKSPACE.has(type);
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'type_ceiling',
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export type UnshareItemResult = {
  /** Whether a live link or contact share was revoked (false: already gone
   *  or not found). */
  revoked: boolean;
};

/**
 * Turn an item's link or contact share off (the share DELETE route,
 * `node_unshare`, `page_unshare`): a plain revoke. Who reads the item is its
 * grants, which a link never changes. Revokes by share
 * id, so an expired link is retired too.
 */
export async function unshareItem(ownerId: string, shareId: string): Promise<UnshareItemResult> {
  return { revoked: await revokeShareTree(ownerId, shareId) };
}

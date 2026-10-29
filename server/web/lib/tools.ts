/**
 * Re-export of the shared tools-registry CRUD. The implementation moved
 * to @mantle/tools (packages/tools/src/crud.ts) so the Toolsmith agent
 * builtins and the MCP server can use the same code paths as the web
 * routes. Kept as a module so existing `@/lib/tools` imports stand.
 */

import { loginHasArea } from '@mantle/db';
import { SECRET_REFS_NEED_KEYS, vaultPairLoginRefusal } from '@mantle/tools';

/**
 * The maker a Tools route records on a tool it writes (tools.created_by):
 * the signed-in login when it is not the brain owner (the
 * anchor login, whose id is the owner id), else null.
 */
export function toolMakerFor(user: { id: string; actor: { id: string } }): string | null {
  return user.actor.id !== user.id ? user.actor.id : null;
}

/**
 * Why the signed-in login may not write a template that sends a vault key
 * (a {{secret:...}} or {{oauth:...}} ref, or an OAuth2 group's token URL or
 * base URL), or null: that is the keys area's (@mantle/tools
 * secret-ref-gate.ts). The brain owner always may.
 */
export async function keysAreaRefusal(user: {
  id: string;
  actor: { id: string };
}): Promise<string | null> {
  const maker = toolMakerFor(user);
  if (!maker) return null;
  return (await loginHasArea(maker, 'keys')) ? null : SECRET_REFS_NEED_KEYS;
}

/**
 * Why the signed-in login may not pair a vault key with a host (a key id
 * with a model route's base URL, a {{secret:...}} ref with a URL), or null:
 * that is the keys area's, and the anchor login always may (@mantle/tools
 * secret-ref-gate.ts).
 */
export async function vaultPairRefusalFor(user: {
  id: string;
  actor: { id: string };
}): Promise<string | null> {
  return vaultPairLoginRefusal(toolMakerFor(user));
}

export {
  listToolsForOwner,
  getToolById,
  createTool,
  updateTool,
  deleteTool,
  type ToolSummary,
  type CreateToolInput,
  type UpdateToolInput,
} from '@mantle/tools';

/**
 * Re-export of the shared tools-registry CRUD. The implementation moved
 * to @mantle/tools (packages/tools/src/crud.ts) so the Toolsmith agent
 * builtins and the MCP server can use the same code paths as the web
 * routes. Kept as a module so existing `@/lib/tools` imports stand.
 */

import { SECRET_REFS_NEED_KEYS, VAULT_PAIR_NEEDS_KEYS } from '@mantle/tools';
import { adminFacts } from '@/lib/auth/login';
import { ownerUserLogin, type SessionUser } from '@/lib/auth/session';

/**
 * The maker a Tools route records on a tool it writes (tools.created_by):
 * the signed-in login when it is not the brain owner (the
 * anchor login, whose id is the owner id), else null.
 */
export function toolMakerFor(user: { id: string; actor: { id: string } }): string | null {
  return user.actor.id !== user.id ? user.actor.id : null;
}

/**
 * Whether the signed-in login holds the keys area: the brain owner always
 * does; any other login as its scope answers it (adminFacts of the owner
 * the handler read, ownerUserLogin; a user no owner answer gave holds none).
 */
async function callerHoldsKeys(user: SessionUser): Promise<boolean> {
  if (!toolMakerFor(user)) return true;
  const login = ownerUserLogin(user);
  return !!login && (await adminFacts(login)).areas.has('keys');
}

/**
 * Why the signed-in login may not write a template that sends a vault key
 * (a {{secret:...}} or {{oauth:...}} ref, or an OAuth2 group's token URL or
 * base URL), or null: that is the keys area's (@mantle/tools
 * secret-ref-gate.ts). The brain owner always may.
 */
export async function keysAreaRefusal(user: SessionUser): Promise<string | null> {
  return (await callerHoldsKeys(user)) ? null : SECRET_REFS_NEED_KEYS;
}

/**
 * Why the signed-in login may not pair a vault key with a host (a key id
 * with a model route's base URL, a {{secret:...}} ref with a URL), or null:
 * that is the keys area's, and the anchor login always may (@mantle/tools
 * secret-ref-gate.ts). The caller's own area, asked as keysAreaRefusal asks
 * it; a pairing recorded for another login is vaultPairLoginRefusal's.
 */
export async function vaultPairRefusalFor(user: SessionUser): Promise<string | null> {
  return (await callerHoldsKeys(user)) ? null : VAULT_PAIR_NEEDS_KEYS;
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

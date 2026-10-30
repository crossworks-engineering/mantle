/**
 * The MCP tools whose call can wait for the owner's approval by their own
 * rule: the vault's replace and delete (toolsmith/vault-keys.ts). Over MCP
 * such a call seals its change on the key's row (@mantle/api-keys vault.ts,
 * a hold) and parks a pending call that names the hold, never the value;
 * the approval runs the tool again (pending.ts), which makes the held
 * change through the vault's gateway.
 *
 * A leaf: pending.ts, builtins-pending.ts and the vault tools read it, so
 * none of them imports another for it.
 *
 *  - They are `mcpOnly`, so no `tools` row holds them: an approval runs
 *    them by the builtin itself (heldToolRow), as the MCP surface does.
 *  - Their approval is never taken over MCP (HELD_ON_MCP_ERROR): an agent
 *    on the connection that asked could otherwise approve its own change.
 *    The Pending screen and a Telegram card take it.
 *  - A rejection drops the hold at once (releaseHeldCall).
 */
import { releaseVaultHolds } from '@mantle/api-keys';
import type { Tool } from '@mantle/db';
import { UUID_RE } from '@mantle/std';

/** The tools whose pending calls hold a vault change. */
export const HELD_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'api_key_set',
  'api_key_delete',
  'api_key_import',
]);

export function isHeldTool(slug: string): boolean {
  return HELD_TOOL_SLUGS.has(slug);
}

/** The refusal of an approval of a held change over MCP. */
export const HELD_ON_MCP_ERROR =
  'A change to a stored key is approved by a person, not over MCP: approve or reject it on the Pending screen in the app (or its Telegram card).';

/** The row an approval runs a held tool by: the builtin itself (it has no
 *  `tools` row, being MCP only), as the MCP surface runs it. Null: not a
 *  held tool. */
export function heldToolRow(slug: string): Tool | null {
  if (!isHeldTool(slug)) return null;
  return { slug, handler: { kind: 'builtin', ref: slug } } as unknown as Tool;
}

/** The hold a held call's arguments name, and its keys: `hold_id` with
 *  `key_id` (a replace, a delete) or `keys[].key_id` (an import). Null:
 *  none named. */
export function heldCallKeys(
  args: Record<string, unknown> | null | undefined,
): { holdId: string; keyIds: string[] } | null {
  const holdId = args?.hold_id;
  if (typeof holdId !== 'string' || !UUID_RE.test(holdId)) return null;
  const keyIds: string[] = [];
  if (typeof args?.key_id === 'string') keyIds.push(args.key_id);
  if (Array.isArray(args?.keys)) {
    for (const k of args.keys as unknown[]) {
      const id = k && typeof k === 'object' ? (k as Record<string, unknown>).key_id : undefined;
      if (typeof id === 'string') keyIds.push(id);
    }
  }
  if (keyIds.length === 0 || !keyIds.every((id) => UUID_RE.test(id))) return null;
  return { holdId, keyIds };
}

/** Drop the holds of a rejected held call (their sealed values go now). */
export async function releaseHeldCall(
  ownerId: string,
  args: Record<string, unknown> | null | undefined,
): Promise<void> {
  const held = heldCallKeys(args);
  if (held) await releaseVaultHolds(ownerId, held.holdId, held.keyIds);
}

/**
 * The MCP tools whose call can wait for the owner's approval by their own
 * rule (`approvalHeld` on the definition): the vault's replace and delete
 * (toolsmith/vault-keys.ts). Over MCP
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
import { tableBuiltin } from './tool-policy';

/** Whether the tool `slug` holds a vault change in its pending calls: an
 *  MCP-only builtin that says so on its definition. */
export function isHeldTool(slug: string): boolean {
  const def = tableBuiltin(slug);
  return def?.approvalHeld === true && def.mcpOnly === true;
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

/** A held change as its pending call shows it (the args' own fields): the
 *  gateway makes it only when this is what its hold sealed. */
export type HeldShown = {
  op: unknown;
  name: unknown;
  kind: unknown;
  target: unknown;
  masked: unknown;
};

/** What a held call's arguments name: `hold_id`, and each key with what
 *  the call shows of its change, from `key_id` and the fields beside it (a
 *  replace, a delete) or `keys[]` (an import). Null: none named. */
export function heldCallKeys(
  args: Record<string, unknown> | null | undefined,
): { holdId: string; keys: { id: string; shown: HeldShown }[] } | null {
  const holdId = args?.hold_id;
  if (typeof holdId !== 'string' || !UUID_RE.test(holdId)) return null;
  const entries: Record<string, unknown>[] = [];
  if (args && typeof args.key_id === 'string') entries.push(args);
  if (Array.isArray(args?.keys)) {
    for (const k of args.keys as unknown[]) {
      if (k && typeof k === 'object') entries.push(k as Record<string, unknown>);
    }
  }
  const keys = entries.map((e) => ({
    id: e.key_id,
    shown: { op: e.op, name: e.name, kind: e.kind, target: e.target, masked: e.masked },
  }));
  if (keys.length === 0 || !keys.every((k) => typeof k.id === 'string' && UUID_RE.test(k.id))) {
    return null;
  }
  return { holdId, keys: keys as { id: string; shown: HeldShown }[] };
}

/** Drop the holds of a rejected held call (their sealed values go now). */
export async function releaseHeldCall(
  ownerId: string,
  args: Record<string, unknown> | null | undefined,
): Promise<void> {
  const held = heldCallKeys(args);
  if (held) {
    await releaseVaultHolds(
      ownerId,
      held.holdId,
      held.keys.map((k) => k.id),
    );
  }
}

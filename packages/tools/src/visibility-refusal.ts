/**
 * The folder system's visibility confirm, as the agent tools speak it
 * (docs/folder-tree.md, "Confirm first"): a write that would change who can
 * see items is refused with the list, and the model is told to ask the user
 * and repeat with `confirm: true` only once they agree. Shared by the tree
 * tools (builtins-tree.ts) and the Files tools (files/*).
 */
import { TreeVisibilityError } from '@mantle/content/tree';
import { BUSY_MESSAGE, isBusy } from '@mantle/db';

/** The `confirm` input every such tool declares (an undeclared key is
 *  dropped by the MCP bridge's schema, so the tool could never go ahead). */
export const CONFIRM_INPUT = {
  type: 'boolean',
  description:
    'go ahead although it changes who can see items; only after the user agreed to the changes a first call listed',
} as const;

/** The refusal text for a TreeVisibilityError (or a busy write: another
 *  change held the rows, review F7), or null for anything else. */
export function visibilityRefusal(err: unknown): string | null {
  if (isBusy(err)) return BUSY_MESSAGE;
  if (!(err instanceof TreeVisibilityError)) return null;
  const shown = err.diff.changes
    .slice(0, 10)
    .map((c) => `'${c.title}' ${c.from} → ${c.to}`)
    .join(', ');
  const through = err.diff.alsoEmbeds ?? [];
  const embedsTotal = err.diff.embedsTotal ?? through.length;
  const also = through.length
    ? ` What they embed changes with them (${embedsTotal}): ${through
        .slice(0, 10)
        .map((c) => `'${c.title}'${c.type ? ` (${c.type})` : ''} ${c.from} → ${c.to}`)
        .join(', ')}${embedsTotal > 10 ? ', …' : ''}.`
    : '';
  const head = err.diff.total
    ? `this changes who can see ${err.diff.total} item(s) (${shown}${err.diff.total > 10 ? ', …' : ''}).`
    : 'this changes who can see items through what they embed.';
  return (
    `${head}${also} ` +
    'Tell the user what changes; call again with confirm: true only once they agree.'
  );
}

/** Said by every agent tool that writes a note's or a page's content
 *  (migration 0208; Jason, 2026-09-30): an embed is shared with the item. */
export const EMBEDS_SHARED =
  " What it embeds (images, files, drawings, child pages, any item by id) is readable by whoever reads it, a shared folder's readers included, whatever kind it is, for as long as it stays shared.";

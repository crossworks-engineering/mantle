/**
 * The folder system's visibility confirm, as the agent tools speak it
 * (docs/folder-tree.md, "Confirm first"): a write that would change who can
 * see items is refused with the list, and the model is told to ask the user
 * and repeat with `confirm: true` only once they agree. Shared by the tree
 * tools (builtins-tree.ts) and the Files tools (files/*).
 */
import { TreeVisibilityError } from '@mantle/content/tree';
import { busyMessage, isBusy } from '@mantle/db';

/** The `confirm` input every such tool declares (an undeclared key is
 *  dropped by the MCP bridge's schema, so the tool could never go ahead). */
export const CONFIRM_INPUT = {
  type: 'boolean',
  description:
    'go ahead although it changes who can see items; only after the user agreed to the changes a first call listed',
} as const;

/** The refusal text for a TreeVisibilityError (or a busy write: another
 *  change held the rows), or null for anything else. */
export function visibilityRefusal(err: unknown): string | null {
  if (isBusy(err)) return busyMessage(err);
  if (!(err instanceof TreeVisibilityError)) return null;
  const names = (list: Array<{ name: string }>) => list.map((w) => w.name).join(', ');
  const shown = err.diff.changes
    .slice(0, 10)
    .map((c) => {
      const parts = [
        c.alsoVisibleTo.length ? `also visible to ${names(c.alsoVisibleTo)}` : '',
        c.removedFrom.length ? `no longer in ${names(c.removedFrom)}` : '',
      ].filter(Boolean);
      // A new item says where it is homed and who only reads it: a folder
      // homed elsewhere passes its home as a read.
      const placed = [
        c.home ? `This will be homed in ${c.home.name}.` : '',
        c.readOnly?.length ? `${names(c.readOnly)} can read it (not edit).` : '',
      ].filter(Boolean);
      return `'${c.title}' ${parts.join('; ')}${placed.length ? `: ${placed.join(' ')}` : ''}`;
    })
    .join(', ');
  return (
    `this changes which workspaces see ${err.diff.total} item(s) (${shown}${err.diff.total > 10 ? ', …' : ''}). ` +
    'Tell the user what changes; call again with confirm: true only once they agree.'
  );
}

/** Said by every agent tool that writes a note's or a page's content
 *  (migration 0208): an embed is shared with the item. */
export const EMBEDS_SHARED =
  " What it embeds (images, files, drawings, child pages, any item by id) is readable by whoever reads it, a shared folder's readers included, whatever kind it is, for as long as it stays shared.";

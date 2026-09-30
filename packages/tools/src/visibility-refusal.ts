/**
 * The folder system's visibility confirm, as the agent tools speak it
 * (docs/folder-tree.md, "Confirm first"): a write that would change who can
 * see items is refused with the list, and the model is told to ask the user
 * and repeat with `confirm: true` only once they agree. Shared by the tree
 * tools (builtins-tree.ts) and the Files tools (files/*).
 */
import { TreeVisibilityError } from '@mantle/content/tree';

/** The `confirm` input every such tool declares (an undeclared key is
 *  dropped by the MCP bridge's schema, so the tool could never go ahead). */
export const CONFIRM_INPUT = {
  type: 'boolean',
  description:
    'go ahead although it changes who can see items; only after the user agreed to the changes a first call listed',
} as const;

/** The refusal text for a TreeVisibilityError, or null for anything else. */
export function visibilityRefusal(err: unknown): string | null {
  if (!(err instanceof TreeVisibilityError)) return null;
  const shown = err.diff.changes
    .slice(0, 10)
    .map((c) => `'${c.title}' ${c.from} → ${c.to}`)
    .join(', ');
  return (
    `this changes who can see ${err.diff.total} item(s) (${shown}${err.diff.total > 10 ? ', …' : ''}). ` +
    'Tell the user what changes; call again with confirm: true only once they agree.'
  );
}

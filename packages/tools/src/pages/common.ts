/**
 * Shared page helpers: the id preconditions,
 * the editing-baseline pick, and the draft-conflict reply.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import type { ToolPrecondition } from '../types';
import { str } from '../coerce';

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING page the owner holds.
export const PAGE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'page_id', nodeType: 'page', lookup: 'page_list / search_nodes' },
];

export const PAGE_NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'page', lookup: 'page_list / search_nodes' },
];

export const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];

export const NOTE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'note_id', nodeType: 'note', lookup: 'note_list / search_nodes' },
];

/** A pages folder to file a new page in (folder phase 7): a `branch` row. */
export const FOLDER_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'folder_id', nodeType: 'branch', lookup: 'tree_folders' },
];

// Body check with one reason: the write looks fine, the page renders broken,
// and nothing reports it. Every `media:` / `page:` / `mention:node:` id must
// name a real node (a dangling ref renders blank). The model cannot see that
// outcome, so this is the only rung that can catch it (see preconditions.ts).
export const MARKDOWN_REFS_PRE: readonly ToolPrecondition[] = [
  { kind: 'markdown_refs', param: 'markdown' },
];

export const MARKDOWN_HINT =
  'Rich-markdown body. GFM markdown plus: callouts (`:::info` … `:::`, variants info|success|warning|danger), asides (`:::aside` … `:::`, a themed-gradient box; optional colour `:::aside chart-3`), columns (`:::columns` … `+++` … `:::`, 2+ parts), task lists (`- [ ]` / `- [x]`), tables, `==highlight==`, coloured spans (`[text]{color=chart-2}` / `[text]{highlight=chart-4}`, accents chart-1…chart-5), KaTeX math (`$E=mc^2$` inline, `$$` … `$$` block), and reference links that keep rich chips intact (`[Label](mention:entity:<id>)`, `![alt](media:<file-id>)`, `[name](media:<file-id>)`, `[Title](page:<page-id>)` — real ids only, standalone lines for the block forms). Same dialect you write replies in.';

/**
 * Pick the baseline doc for a block-edit op: the draft if one exists
 * (an in-flight editing session — the agent's previous edit + the user's
 * autosave land there), else the published doc. Block edits always
 * write back to draft_doc; the user reviews + commits.
 */
export function pickEditingBaseline(page: {
  doc: Record<string, unknown>;
  draft: Record<string, unknown> | null;
}): Record<string, unknown> {
  return (page.draft ?? page.doc) as Record<string, unknown>;
}

export const DRAFT_REVIEW_HINT = (pageId: string) =>
  `Edit applied to DRAFT — the published page is unchanged. Tell the ` +
  `user to open /pages/${pageId} to review; the editor shows the draft. ` +
  `Commit publishes, Discard reverts.`;

/**
 * The draft moved between our read and our conditional save — a user autosave
 * (or another agent op) bumped `draft_rev` under us, so `saveDraft` refused
 * rather than clobber it (optimistic concurrency, audit item #3). The block ops
 * computed their new doc from the stale baseline, so a blind retry would clobber
 * just the same: the correct merge point is the AGENT re-reading. Bounce it back
 * with that instruction — never auto-retry here.
 */
export const draftConflict = (pageId: string): { ok: false; error: string } => ({
  ok: false,
  error:
    `page ${pageId} changed since you read it — a concurrent edit (a user autosave ` +
    `in the editor, or another block op) advanced the draft. Your change was ` +
    `computed against the older content and was NOT saved (saving it would have ` +
    `silently overwritten that edit). Re-read the page with page_blocks_list ` +
    `(or page_get for one block), re-apply your edit against the current content, ` +
    `then re-issue.`,
});

/** Where a new page goes (folder phase 7): a folder of the pages tree. */
export const FOLDER_ID_PROP = {
  type: 'string',
  format: 'uuid',
  description:
    'the pages folder to file the new page in, from `tree_folders` (kind pages); omit for the top level',
} as const;

/** The pre-tree way to place a page, kept so older callers still land near
 *  where they meant to: pages do not nest any more. */
export const PARENT_ID_PROP = {
  type: 'string',
  format: 'uuid',
  description:
    'DEPRECATED, pages do not nest: a page id here files the new page in the SAME FOLDER as that page. Prefer `folder_id`.',
} as const;

/** The placement a create-a-page tool passes to `createPage`: `folder_id`
 *  wins over the deprecated `parent_id`; neither means the top level. */
export function placementOf(input: Record<string, unknown>): {
  folderId?: string;
  parentId?: string;
} {
  const folderId = str(input.folder_id).trim();
  if (folderId) return { folderId };
  const parentId = str(input.parent_id).trim();
  return parentId ? { parentId } : {};
}

/** The placement as a tool echoes it back (only what was given). */
export function placementOutput(placement: { folderId?: string; parentId?: string }): {
  folder_id?: string;
  parent_id?: string;
} {
  return {
    ...(placement.folderId ? { folder_id: placement.folderId } : {}),
    ...(placement.parentId ? { parent_id: placement.parentId } : {}),
  };
}

/** The teaching error for a placement `createPage` refused
 *  (PageFolderNotFoundError, ParentPageNotFoundError), or null. */
export function placementError(
  message: string,
  placement: { folderId?: string; parentId?: string },
): string | null {
  if (placement.folderId && message.includes('folder not found')) {
    return `folder_id '${placement.folderId}' is not a folder of your pages — pass the id of a pages folder (see tree_folders with kind pages), or omit it for the top level.`;
  }
  if (placement.parentId && message.includes('parent page not found')) {
    return `parent_id '${placement.parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes), or better a folder_id (tree_folders, kind pages).`;
  }
  return null;
}

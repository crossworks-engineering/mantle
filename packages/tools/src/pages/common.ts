/**
 * Shared page helpers: owner-only tag stripping, the id preconditions,
 * the editing-baseline pick, and the draft-conflict reply.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import type { ToolPrecondition } from '../types';

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING page the owner holds.
/** The `recall` and `prompt` tags are OWNER GESTURES — `recall` turns a page
 *  tree into a served map, `prompt` makes a page auto-matchable by
 *  recall_match, and the security model (docs/recall.md) rests on a human
 *  making both calls in the editor. Agent-facing page tools therefore strip
 *  them: agents can DRAFT map and prompt pages freely; the owner activates
 *  them by tagging. (S7's recall_propose_* tools will route activation
 *  through pending approvals instead.) */
const OWNER_ONLY_TAGS = new Set(['recall', 'prompt']);

export function stripOwnerOnlyTags(tags: string[]): { tags: string[]; stripped: string[] } {
  const stripped = tags.filter((x) => OWNER_ONLY_TAGS.has(x.trim().toLowerCase()));
  return {
    tags: tags.filter((x) => !OWNER_ONLY_TAGS.has(x.trim().toLowerCase())),
    stripped,
  };
}

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

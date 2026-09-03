/**
 * Page builtins — let an agent author rich documents in the user's Mantle.
 * Pages store their body as ProseMirror JSON (`pages.doc`), so these wrap the
 * `@mantle/content` page CRUD and convert the agent's rich-markdown dialect to
 * that JSON via `markdownToDoc`. A page insert/commit fires `node_ingested`, so
 * the extractor indexes it (summary + embedding + facts + entities) like any
 * other content — created/updated pages are immediately searchable + recallable.
 *
 * The dialect (callouts/columns/tables/task-lists/highlights) is the same one
 * the rich_writing skill teaches and the /assistant renders, so a page Saskia
 * writes looks identical to the reply she showed in chat.
 */

import type { BuiltinToolDef } from './types';
import {
  page_create,
  page_replace_from_file,
  page_update,
  page_update_draft,
  page_commit,
  page_discard_draft,
  page_delete,
} from './pages/lifecycle';
import { page_list, page_get } from './pages/read';
import { page_from_file, page_from_note, page_from_notes, page_from_journal } from './pages/from';
import {
  page_blocks_list,
  page_block_get,
  page_block_update,
  page_block_insert_after,
  page_block_insert_before,
  page_block_append,
  page_block_delete,
} from './pages/blocks';
import { page_blocks_apply } from './pages/apply';
import { page_split, page_extract_section, page_move, page_mention } from './pages/structure';
import { page_share, page_unshare } from './pages/sharing';

export const PAGE_TOOLS: BuiltinToolDef[] = [
  page_create,
  page_from_file,
  page_from_note,
  page_from_notes,
  page_from_journal,
  page_replace_from_file,
  page_update,
  page_update_draft,
  page_blocks_list,
  page_block_get,
  page_block_update,
  page_block_insert_after,
  page_block_insert_before,
  page_block_append,
  page_block_delete,
  page_blocks_apply,
  page_commit,
  page_discard_draft,
  page_split,
  page_extract_section,
  page_move,
  page_mention,
  page_delete,
  page_list,
  page_get,
  page_share,
  page_unshare,
];

export const PAGE_TOOL_SLUGS: string[] = PAGE_TOOLS.map((t) => t.slug);

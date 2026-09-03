/**
 * Page lifecycle: create, replace from a file, update metadata and
 * draft body, commit, discard, delete.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import {
  createPage,
  updatePage,
  deletePage,
  getPage,
  markdownToDoc,
  docToText,
  saveDraft,
  discardDraft,
  commitPageDraft,
  nodeUrl,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import {
  FILE_ID_PRE,
  MARKDOWN_HINT,
  MARKDOWN_REFS_PRE,
  PAGE_ID_PRE,
  PAGE_NODE_ID_PRE,
  stripOwnerOnlyTags,
} from './common';

export const page_create: BuiltinToolDef = {
  slug: 'page_create',
  preconditions: MARKDOWN_REFS_PRE,
  name: 'Create a page',
  description:
    "Create a rich document (a `page` node under /pages) in the user's Mantle from content YOU compose. The page is indexed into the brain — summary, embedding, facts, entities — so it becomes searchable and recallable. To make a SUB-PAGE, pass `parent_id` (an existing page's id); omit for a top-level page. Prefer this over `note_create` when the content is long-form or structured (a plan, a doc, a comparison); use `note_create` for quick plain-text captures. **For importing an existing file use `page_from_file` instead — re-emitting the file body in `markdown` truncates silently above ~6 K output tokens. When the content already lives in a NOTE, use `page_from_note` — it copies the body server-side.**",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'page title, e.g. "Q3 Launch Plan"' },
      markdown: { type: 'string', description: MARKDOWN_HINT },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional — id of an existing page to nest this new page UNDER (creates a sub-page). Omit for a top-level page.',
      },
    },
    required: ['title'],
  },
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title is required' };
    const markdown = str(input.markdown);
    const { tags, stripped: strippedTags } = stripOwnerOnlyTags(strArr(input.tags));
    const icon = str(input.icon).trim();
    const parentId = str(input.parent_id).trim();
    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title: title.slice(0, 200),
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      ctx.step?.setOutput({ id: page.id, title: page.title });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page created by tool: ${page.title}`,
        payload: {
          via: 'page_create_tool',
          tags,
          ...(parentId ? { parentId } : {}),
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown,
      });
      return {
        ok: true,
        output: {
          id: page.id,
          url: nodeUrl(page.id),
          title: page.title,
          tags: page.tags,
          ...(parentId ? { parent_id: parentId } : {}),
          ...(strippedTags.length > 0
            ? {
                note: `The ${strippedTags.map((x) => `\`${x}\``).join(', ')} tag is owner-only — the owner sets it in the editor to turn a tree into a Recall map.`,
              }
            : {}),
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      // createPage throws ParentPageNotFoundError ("…parent page not found") when
      // parent_id isn't one of the owner's pages — surface that plainly.
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

export const page_replace_from_file: BuiltinToolDef = {
  slug: 'page_replace_from_file',
  preconditions: [...PAGE_ID_PRE, ...FILE_ID_PRE],
  name: 'Replace an existing page from a file',
  description:
    "Rebuild an EXISTING page's body from a markdown/text file's bytes. Writes the new body to `draft_doc` ONLY — the published `doc` is untouched until the operator commits. Like `page_from_file` but updates a target page instead of creating a new one. **The right tool for: 'this page is corrupted, reimport from the source file' / 'I re-exported this page from Notion, refresh it here'.** Bytes go server-side without round-tripping through your output, so this scales to any file size — the deterministic recovery path. Title / tags / icon stay as-is unless you pass replacements. Only text-like files are accepted (markdown / plain text); binaries are rejected.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the existing page to rebuild' },
      file_id: {
        type: 'string',
        format: 'uuid',
        description: 'id of the file node holding the new body',
      },
      title: { type: 'string', description: 'optional new page title; omit to keep current' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional new tags; omit to keep current',
      },
      icon: { type: 'string', description: 'optional new emoji icon' },
    },
    required: ['page_id', 'file_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const fileId = str(input.file_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!fileId) return { ok: false, error: 'file_id is required' };

    // Verify the page exists + belongs to this owner BEFORE pulling file
    // bytes — clean 404 instead of an opaque draft-save failure.
    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'file_list / search_nodes');
    if (!meta.isText) {
      return {
        ok: false,
        error:
          `page_replace_from_file: '${meta.filename}' is a binary file ` +
          `(mime='${meta.mimeType}') and cannot be imported as page content. ` +
          `Convert to markdown first.`,
      };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    try {
      // Metadata patch — only if the caller asked. Goes directly to the
      // nodes row via updatePage (no doc field → published doc untouched).
      const metaPatch: Record<string, unknown> = {};
      if (typeof input.title === 'string' && input.title.trim()) {
        metaPatch.title = input.title.trim().slice(0, 200);
      }
      if (Array.isArray(input.tags)) metaPatch.tags = stripOwnerOnlyTags(strArr(input.tags)).tags;
      if (typeof input.icon === 'string' && input.icon.trim()) {
        metaPatch.icon = input.icon.trim();
      }
      if (Object.keys(metaPatch).length > 0) {
        const r = await updatePage(ctx.ownerId, pageId, metaPatch);
        if (!r) return { ok: false, error: `page ${pageId} disappeared mid-call` };
      }

      // Body: bytes → doc → draft. saveDraft runs ensureBlockIds so the
      // imported content lands with stable per-block ids, ready for the
      // Phase 2b block tools + the editor diff view.
      // Intentionally UNCONDITIONAL (no baseRev): the new body is built wholesale
      // from the file bytes, never from a read of the page's current draft — this
      // tool's contract is a full-body replace, so there is no concurrent edit to
      // preserve. (Contrast the block-op tools, which DO thread baseRev.)
      const markdown = res.bytes.toString('utf8');
      const doc = markdownToDoc(markdown);
      const saved = await saveDraft(ctx.ownerId, pageId, doc);
      if (!saved.ok) return { ok: false, error: `page ${pageId} disappeared mid-call` };

      ctx.step?.setOutput({
        page_id: pageId,
        source_file_id: fileId,
        source_byte_size: res.bytes.length,
        meta_updated: Object.keys(metaPatch).length > 0,
      });
      return {
        ok: true,
        output: {
          page_id: pageId,
          source_file_id: fileId,
          source_byte_size: res.bytes.length,
          meta_updated: Object.keys(metaPatch).length > 0,
          draft_saved: true,
          hint:
            `New body landed in DRAFT (${res.bytes.length} source bytes from ` +
            `'${meta.filename}'). Tell the user to open /pages/${pageId} to ` +
            `review; the editor shows the draft. Commit publishes the rebuild, ` +
            `Discard reverts to the current published doc.`,
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_update: BuiltinToolDef = {
  slug: 'page_update',
  name: 'Update a page',
  preconditions: [...PAGE_NODE_ID_PRE, ...MARKDOWN_REFS_PRE],
  description:
    "Update an existing page by id. **Pass ONLY the fields you're changing — every other field is left untouched.** Fixing the title? Pass `{ id, title }`, nothing else. Pass `markdown` ONLY when you intend to REPLACE the whole body in one shot (re-converted, page re-indexed) — re-emitting it just to bundle a metadata fix is wasted output tokens and risks truncation. Use `page_get` first if you need the current content before crafting a replacement. **For styling/restyling/reformatting an existing page (callouts, columns, restructure), DELEGATE to the `pages` agent via `invoke_agent` instead — the pages agent writes to draft_doc only and won't silently overwrite the live page on a bad transform.**",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
      title: { type: 'string', description: 'new page title; replaces the current one' },
      markdown: { type: 'string', description: `Replacement body. ${MARKDOWN_HINT}` },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Labels for organisation and filtering, e.g. ['work']. Replaces the current tag set.",
      },
      icon: { type: 'string', description: 'new emoji icon, e.g. "📄"' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const patch: Record<string, unknown> = {};
    if (typeof input.title === 'string') patch.title = input.title.trim().slice(0, 200);
    if (typeof input.markdown === 'string') patch.doc = markdownToDoc(input.markdown);
    if (Array.isArray(input.tags)) patch.tags = stripOwnerOnlyTags(strArr(input.tags)).tags;
    if (typeof input.icon === 'string') patch.icon = input.icon.trim();
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'nothing to update — pass title, markdown, tags, or icon' };
    }
    try {
      const page = await updatePage(ctx.ownerId, id, patch);
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      ctx.step?.setOutput({ id: page.id, title: page.title });
      return {
        ok: true,
        output: { id: page.id, url: nodeUrl(page.id), title: page.title, tags: page.tags },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_update_draft: BuiltinToolDef = {
  slug: 'page_update_draft',
  preconditions: [...PAGE_NODE_ID_PRE, ...MARKDOWN_REFS_PRE],
  name: 'Update a page (draft-only)',
  description:
    "Update an existing page WITHOUT publishing. Body changes (`markdown`) go to `draft_doc` — the published `doc` and its brain index are untouched until the operator opens the editor and commits. Metadata (`title` / `tags` / `icon`) updates apply directly (easily reversible if wrong). **The Pages agent uses this instead of `page_update` so a misbehaving transform can never silently overwrite the published page.** Pass ONLY the fields you're changing — every other field is left untouched. Returns a hint telling the user where to review the draft.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id' },
      title: {
        type: 'string',
        description: 'new page title; replaces the current one (applies directly, not via draft)',
      },
      markdown: {
        type: 'string',
        description: `Replacement body — written to draft_doc, NOT the published doc. ${MARKDOWN_HINT}`,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Labels for organisation and filtering, e.g. ['work']. Replaces the current tag set (applies directly, not via draft).",
      },
      icon: {
        type: 'string',
        description: 'new emoji icon, e.g. "📄" (applies directly, not via draft)',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };

    // Metadata patch (low-risk, direct). Body change goes to draft separately.
    const metaPatch: Record<string, unknown> = {};
    if (typeof input.title === 'string') metaPatch.title = input.title.trim().slice(0, 200);
    if (Array.isArray(input.tags)) metaPatch.tags = stripOwnerOnlyTags(strArr(input.tags)).tags;
    if (typeof input.icon === 'string') metaPatch.icon = input.icon.trim();

    let metaUpdated = false;
    if (Object.keys(metaPatch).length > 0) {
      try {
        const result = await updatePage(ctx.ownerId, id, metaPatch);
        if (!result) return notFound('page', id, 'page_list / search_nodes');
        metaUpdated = true;
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }

    // Body change → draft only. saveDraft writes to pages.draft_doc and
    // bumps draft_updated_at; the published `doc`, doc_text, summary,
    // embedding, entities all stay as they were.
    let draftSaved = false;
    if (typeof input.markdown === 'string') {
      try {
        // Intentionally UNCONDITIONAL (no baseRev): the draft is replaced wholesale
        // from agent-supplied markdown, never derived from a read of the current
        // draft — so there is no concurrent edit to lose. (The block-op tools, which
        // DO base their doc on a read, thread baseRev to guard the user's edits.)
        const doc = markdownToDoc(input.markdown);
        const res = await saveDraft(ctx.ownerId, id, doc);
        if (!res.ok) return notFound('page', id, 'page_list / search_nodes');
        draftSaved = true;
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }

    if (!metaUpdated && !draftSaved) {
      return { ok: false, error: 'nothing to update — pass title, markdown, tags, or icon' };
    }

    ctx.step?.setOutput({ id, meta_updated: metaUpdated, draft_saved: draftSaved });
    return {
      ok: true,
      output: {
        id,
        url: nodeUrl(id),
        ...(typeof metaPatch.title === 'string' ? { title: metaPatch.title } : {}),
        meta_updated: metaUpdated,
        draft_saved: draftSaved,
        ...(draftSaved
          ? {
              hint:
                `Body changes are in DRAFT only — the published page is unchanged. ` +
                `Tell the user to open /pages/${id} to review the proposed body; ` +
                `the editor shows the draft. Commit publishes, Discard reverts.`,
            }
          : {}),
      },
    };
  },
};

export const page_commit: BuiltinToolDef = {
  slug: 'page_commit',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Commit a page draft',
  description:
    "Publish a page's pending draft as the canonical body and re-index it into the brain. Use after a batch of body edits when the user has confirmed they want the changes live (or asked you to 'save'/'publish'). No-op error if there's no draft. Usually you LEAVE the draft for the user to review + commit in the editor — only commit yourself when explicitly asked. Publishing is what makes the new body searchable and recallable; until then only the old one is.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The page's id (UUID) — from `page_list`." },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const result = await commitPageDraft(ctx.ownerId, id);
      if (!result.ok) {
        if ('missing' in result) return notFound('page', id, 'page_list / search_nodes');
        if ('noDraft' in result) {
          return {
            ok: false,
            error:
              'no draft to commit — this page has no pending changes. The published body is already current.',
          };
        }
        // An editor autosave landed between reading the draft and publishing
        // it. Nothing was published: whatever is in the draft NOW is newer
        // than what this call read, so re-read before deciding again.
        return {
          ok: false,
          error: `the draft changed while committing (server rev ${result.rev}) — nothing was published. Re-read the page and retry if the change is still wanted.`,
        };
      }
      const page = result.page;
      ctx.step?.setOutput({ id, committed: true });
      const snippet = docToText(page.doc);
      void recordIngest({
        source: 'page_commit',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page committed: ${page.title.slice(0, 80)}`,
        payload: {
          via: 'page_commit_tool',
          title: page.title,
          tags: page.tags,
          textChars: snippet.length,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet,
      });
      return {
        ok: true,
        output: { id, committed: true, url: nodeUrl(id), title: page.title },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_discard_draft: BuiltinToolDef = {
  slug: 'page_discard_draft',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Discard a page draft',
  description:
    "Throw away a page's pending draft, leaving the published body and its brain index exactly as they are. Use when a body edit went wrong and you want to abandon it — otherwise the bad draft shadows the published page for every later block tool and for anyone who opens the editor. Idempotent. Only discard your OWN unwanted edits: a draft the user is still reviewing is theirs to keep or drop, and this cannot be undone.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: "The page's id (UUID) — from `page_list`." },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await discardDraft(ctx.ownerId, id);
      if (!ok) return notFound('page', id, 'page_list / search_nodes');
      ctx.step?.setOutput({ id, discarded: true });
      return { ok: true, output: { id, discarded: true, url: nodeUrl(id) } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_delete: BuiltinToolDef = {
  slug: 'page_delete',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Delete a page',
  description:
    'Permanently delete a page by id. This is irreversible — the document and its index entries are removed. Confirm with the user before calling.',
  // Destructive + irreversible: pause for operator approval by default. Flip
  // requires_confirm off in the tools table if you trust the agent fully.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id to delete' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await deletePage(ctx.ownerId, id);
      if (!ok) return notFound('page', id, 'page_list / search_nodes');
      ctx.step?.setOutput({ id, deleted: true });
      return { ok: true, output: { id, deleted: true } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};
